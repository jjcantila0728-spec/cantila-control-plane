/* ============================================================
   Multi-conversation chat history (conversations design 2026-05-30).
   In-memory store, fully offline. Covers ensureDefaultConversation
   idempotency + null-row backfill, CRUD (with delete cascade),
   chat-persist auto-title + conversationId attach, and
   listConversations ordering + counts.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import type { ProjectChatMessage } from "../domain/types";

function makeCp(): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

async function seedProject(
  cp: ControlPlane,
  store: InMemoryStore,
): Promise<string> {
  await store.createAccount({
    id: "acc_test",
    name: "Cantila",
    handle: "cantila",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  const project = await cp.createProject({
    accountId: "acc_test",
    name: "Homes",
    runtime: "node",
    region: "fsn1",
  });
  return project.id;
}

/** Insert a legacy null-conversation message directly via the store —
 *  simulating rows that predate the conversation column. */
async function seedNullMessage(
  store: InMemoryStore,
  projectId: string,
  content: string,
  createdAt: string,
): Promise<void> {
  const m: ProjectChatMessage = {
    id: `pmsg_${content}_${createdAt}`,
    projectId,
    conversationId: null,
    role: "user",
    kind: "message",
    content,
    createdAt,
  };
  await store.createChatMessage(m);
}

test("ensureDefaultConversation is idempotent and backfills null-conversation messages into Main", async () => {
  const { cp, store } = makeCp();
  const projectId = await seedProject(cp, store);

  // Two legacy messages with no conversation yet.
  await seedNullMessage(store, projectId, "hello", "2026-05-01T00:00:00.000Z");
  await seedNullMessage(store, projectId, "world", "2026-05-01T00:00:01.000Z");

  const first = await cp.ensureDefaultConversation(projectId);
  assert.ok(first, "returns a default conversation id");

  // Idempotent — second call returns the same id, no second conversation.
  const second = await cp.ensureDefaultConversation(projectId);
  assert.equal(second, first, "idempotent: same id on repeat");
  const conversations = await store.listConversations(projectId);
  assert.equal(conversations.length, 1, "only one conversation exists");
  assert.equal(conversations[0].title, "Main", "default is titled Main");

  // Both legacy messages were backfilled into the default conversation.
  const scoped = await store.listChatMessages(first);
  assert.equal(scoped.length, 2, "both null messages backfilled");
  assert.deepEqual(
    scoped.map((m) => m.content),
    ["hello", "world"],
    "backfilled messages preserved in created-at order",
  );
});

test("create / rename / delete conversation (delete cascades its messages)", async () => {
  const { cp, store } = makeCp();
  const projectId = await seedProject(cp, store);

  const created = await cp.createConversation(projectId);
  assert.ok(created, "conversation created");
  assert.equal(created!.title, "New chat", "default title is New chat");

  const named = await cp.createConversation(projectId, "Planning");
  assert.equal(named!.title, "Planning", "explicit title honored");

  // Rename.
  const renamed = await cp.renameConversation(projectId, created!.id, "Renamed");
  assert.ok(renamed);
  assert.equal(renamed!.title, "Renamed");

  // Rename a non-existent / wrong-project conversation → null (404).
  const missing = await cp.renameConversation(projectId, "conv_nope", "x");
  assert.equal(missing, null);

  // Attach messages to `created`, then delete it — messages cascade away.
  await cp.appendChatMessage({
    projectId,
    conversationId: created!.id,
    role: "user",
    kind: "message",
    content: "to be deleted",
  });
  assert.equal((await store.listChatMessages(created!.id)).length, 1);

  const del = await cp.deleteConversation(projectId, created!.id);
  assert.deepEqual(del, { ok: true });
  assert.equal(await store.getConversation(created!.id), null, "conversation gone");
  assert.equal(
    (await store.listChatMessages(created!.id)).length,
    0,
    "messages cascade-deleted",
  );

  // Deleting an unknown conversation → null (404).
  assert.equal(await cp.deleteConversation(projectId, "conv_nope"), null);

  // The other conversation is untouched.
  assert.ok(await store.getConversation(named!.id));
});

test("chat persistence attaches conversationId and auto-titles an untitled conversation from the first user message", async () => {
  const { cp, store } = makeCp();
  const projectId = await seedProject(cp, store);

  const conv = await cp.createConversation(projectId); // title "New chat"
  assert.equal(conv!.title, "New chat");

  // First user message auto-titles the untitled thread.
  const msg = await cp.appendChatMessage({
    projectId,
    conversationId: conv!.id,
    role: "user",
    kind: "message",
    content: "Build me a landing page for my coffee shop",
  });
  assert.equal(msg.conversationId, conv!.id, "message carries the conversationId");

  const afterFirst = await store.getConversation(conv!.id);
  assert.equal(
    afterFirst!.title,
    "Build me a landing page for my coffee shop",
    "auto-titled from the first user message",
  );

  // A second user message does NOT re-title (it's no longer "New chat").
  await cp.appendChatMessage({
    projectId,
    conversationId: conv!.id,
    role: "user",
    kind: "message",
    content: "Actually make it about tea",
  });
  const afterSecond = await store.getConversation(conv!.id);
  assert.equal(
    afterSecond!.title,
    "Build me a landing page for my coffee shop",
    "title is not overwritten by later messages",
  );

  // The backfilled default "Main" conversation is never auto-titled (only
  // "New chat" threads are). Use a fresh project whose only conversation is
  // the ensured "Main".
  const { cp: cp2, store: store2 } = makeCp();
  const project2 = await seedProject(cp2, store2);
  const mainId = await cp2.ensureDefaultConversation(project2);
  assert.equal((await store2.getConversation(mainId))!.title, "Main");

  const defaultMsg = await cp2.appendChatMessage({
    projectId: project2,
    role: "user",
    kind: "message",
    content: "into the default thread",
  });
  assert.equal(defaultMsg.conversationId, mainId, "omitted id routes to Main");
  assert.equal(
    (await store2.getConversation(mainId))!.title,
    "Main",
    "Main is never auto-renamed",
  );
});

test("listConversations orders by updatedAt desc and reports messageCount + lastPreview", async () => {
  const { cp, store } = makeCp();
  const projectId = await seedProject(cp, store);

  const a = await cp.createConversation(projectId, "Alpha");
  const b = await cp.createConversation(projectId, "Beta");

  // Put two messages in A, then one (more recent) in B, so B is most-active.
  await cp.appendChatMessage({
    projectId,
    conversationId: a!.id,
    role: "user",
    kind: "message",
    content: "first in alpha",
  });
  await cp.appendChatMessage({
    projectId,
    conversationId: a!.id,
    role: "agent",
    agent: "orchestrator",
    kind: "message",
    content: "reply in alpha",
  });
  await cp.appendChatMessage({
    projectId,
    conversationId: b!.id,
    role: "user",
    kind: "message",
    content: "the latest message lives in beta",
  });

  // Pin distinct updatedAt values so the ordering assertion is independent
  // of sub-millisecond wall-clock collisions (the appends above all bump
  // updatedAt via `now()`, which can tie). Beta is the most-recently-active.
  await store.updateConversation(a!.id, {
    updatedAt: "2026-05-30T00:00:01.000Z",
  });
  await store.updateConversation(b!.id, {
    updatedAt: "2026-05-30T00:00:02.000Z",
  });

  const list = await cp.listConversations(projectId);
  assert.ok(list, "list returned (project exists)");
  // Alpha + Beta already exist, so no default "Main" is ensured.
  assert.equal(list!.length, 2, "Alpha + Beta");

  // Most-recently-active first — Beta got the last message, so it leads.
  assert.equal(list![0].title, "Beta", "Beta (more recent) ordered first");
  assert.equal(list![1].title, "Alpha");

  const alpha = list!.find((c) => c.title === "Alpha")!;
  const beta = list!.find((c) => c.title === "Beta")!;
  assert.equal(alpha.messageCount, 2, "Alpha has 2 messages");
  assert.equal(beta.messageCount, 1, "Beta has 1 message");
  assert.equal(
    beta.lastPreview,
    "the latest message lives in beta",
    "lastPreview is the most recent message content",
  );
  assert.equal(
    alpha.lastPreview,
    "reply in alpha",
    "Alpha preview is its last message",
  );
});

test("appendChatMessage with a conversationId from a DIFFERENT project falls back to the caller project's default (cross-project write scoping)", async () => {
  const { cp, store } = makeCp();

  // Two projects under the same account. `seedProject` creates project A;
  // create project B directly so we have a foreign conversation to target.
  const projectA = await seedProject(cp, store);
  const projectB = (
    await cp.createProject({
      accountId: "acc_test",
      name: "Other",
      runtime: "node",
      region: "fsn1",
    })
  ).id;

  // A conversation that belongs to project B.
  const foreign = await cp.createConversation(projectB, "B-thread");
  assert.ok(foreign);

  // Caller is scoped to project A but supplies project B's conversationId.
  const msg = await cp.appendChatMessage({
    projectId: projectA,
    conversationId: foreign!.id,
    role: "user",
    kind: "message",
    content: "should not land in project B",
  });

  // The write must NOT land in the foreign conversation.
  assert.notEqual(
    msg.conversationId,
    foreign!.id,
    "did not write into the other project's thread",
  );
  assert.equal(
    (await store.listChatMessages(foreign!.id)).length,
    0,
    "foreign conversation untouched",
  );

  // It fell back to project A's default ("Main") conversation.
  const defaultA = await cp.ensureDefaultConversation(projectA);
  assert.equal(msg.conversationId, defaultA, "fell back to caller's default");
  const scoped = await store.listChatMessages(defaultA);
  assert.equal(scoped.length, 1, "message landed in caller's default thread");
  assert.equal(scoped[0].content, "should not land in project B");
  assert.equal(scoped[0].projectId, projectA, "message is scoped to project A");
});

test("listConversations ensures a default Main when the project has none", async () => {
  const { cp, store } = makeCp();
  const projectId = await seedProject(cp, store);

  const list = await cp.listConversations(projectId);
  assert.ok(list);
  assert.equal(list!.length, 1, "an empty project gets exactly one default");
  assert.equal(list![0].title, "Main");
  assert.equal(list![0].messageCount, 0);
  assert.equal(list![0].lastPreview, "");

  // Project that doesn't exist → null (404 at the route).
  assert.equal(await cp.listConversations("prj_nope"), null);
});

/* ============================================================
   Project + database deletion (offline, stubs).
   Verifies deleteProject cascades every project-scoped row and
   deleteProjectDatabase removes just the DB + DATABASE_URL.
   ============================================================ */

import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { mailboxProvisioner } from "../mail/provisioner";

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

async function seedProject(cp: ControlPlane, store: InMemoryStore) {
  await store.createAccount({
    id: "acc_test",
    name: "Test",
    handle: "test",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  return cp.createProject({
    accountId: "acc_test",
    name: "demo",
    runtime: "node",
    region: "fsn1",
  });
}

test("deleteProject removes the project and all its rows", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  await cp.provisionDb(project.id); // creates DB + injects DATABASE_URL
  await cp.addDomain(project.id, "www.example.com");

  // Sanity — the rows exist before deletion.
  assert.ok(await store.getDatabaseByProject(project.id));
  assert.ok((await store.listDomains(project.id)).length >= 1);
  assert.ok((await store.listEnvVars(project.id)).length >= 1);

  const result = await cp.deleteProject(project.id);
  assert.deepEqual(result, { ok: true, slug: project.slug });

  assert.equal(await store.getProject(project.id), null);
  assert.equal(await store.getDatabaseByProject(project.id), null);
  assert.equal((await store.listDomains(project.id)).length, 0);
  assert.equal((await store.listEnvVars(project.id)).length, 0);
});

test("deleteProject on a missing project returns an error", async () => {
  const { cp } = makeCp();
  const result = await cp.deleteProject("prj_nope");
  assert.deepEqual(result, { error: "project not found" });
});

test("deleteProjectDatabase removes the DB + DATABASE_URL, keeps the project", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  await cp.provisionDb(project.id);

  assert.ok(await store.getDatabaseByProject(project.id));
  assert.ok(
    (await store.listEnvVars(project.id)).some((e) => e.key === "DATABASE_URL"),
  );

  const result = await cp.deleteProjectDatabase(project.id);
  assert.deepEqual(result, { ok: true });

  assert.equal(await store.getDatabaseByProject(project.id), null);
  assert.equal(
    (await store.listEnvVars(project.id)).some((e) => e.key === "DATABASE_URL"),
    false,
  );
  // Project itself survives.
  assert.ok(await store.getProject(project.id));
});

test("deleteProjectDatabase with no database returns an error", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  const result = await cp.deleteProjectDatabase(project.id);
  assert.deepEqual(result, { error: "no database on this project" });
});

test("deleteProject deletes real mailboxes via the provisioner (best-effort)", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  const made = await cp.createHostedMailbox({
    projectId: project.id,
    address: "hello@example.com",
  });
  assert.ok(!("error" in made), "mailbox seed should succeed");

  const spy = mock.method(mailboxProvisioner, "deleteMailbox");
  try {
    const result = await cp.deleteProject(project.id);
    assert.deepEqual(result, { ok: true, slug: project.slug });
    assert.equal(spy.mock.callCount(), 1);
    assert.deepEqual(spy.mock.calls[0].arguments, ["hello@example.com"]);
    assert.equal(
      (await store.listHostedMailboxesByProject(project.id)).length,
      0,
    );
  } finally {
    spy.mock.restore();
  }
});

test("deleteProject still succeeds when mailbox teardown throws", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  await cp.createHostedMailbox({ projectId: project.id, address: "x@example.com" });

  const spy = mock.method(mailboxProvisioner, "deleteMailbox", async () => {
    throw new Error("mailcow down");
  });
  try {
    const result = await cp.deleteProject(project.id);
    assert.deepEqual(result, { ok: true, slug: project.slug });
    assert.equal(await store.getProject(project.id), null);
  } finally {
    spy.mock.restore();
  }
});

test("deleteProject releases the project's SMS number", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);
  const phone = await cp.activateSms("acc_test", project.id, {
    country: "US",
    numberType: "local",
  });
  assert.ok(!("error" in phone), "SMS activation should succeed");
  const stored = await store.getPhoneNumberByProject(project.id);
  assert.ok(stored?.marketplaceNumberId, "number linked to a marketplace row");
  const mpId = stored!.marketplaceNumberId!;

  const result = await cp.deleteProject(project.id);
  assert.deepEqual(result, { ok: true, slug: project.slug });

  // Project number row is gone (cascade) and the carrier lease was released.
  assert.equal(await store.getPhoneNumberByProject(project.id), null);
  const mp = await store.getMarketplaceNumber(mpId);
  assert.equal(mp?.status, "released");
});

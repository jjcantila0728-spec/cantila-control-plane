import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

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

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

async function seed(store: InMemoryStore) {
  await store.createAccount({ id: "acc_1", name: "One", handle: "one", plan: "starter", createdAt: T(0) });
  await store.createUser({ id: "usr_owner", email: "owner@one.com", name: "Owner", twoFactorEnabled: false, accountId: "acc_1", createdAt: T(1) });
  await store.createMembership({ id: "mem_1", userId: "usr_owner", accountId: "acc_1", role: "owner", createdAt: T(1) });
  await store.createProject({ id: "prj_1", accountId: "acc_1", slug: "p1", name: "p1", runtime: "node", region: "fsn1", status: "live", createdAt: T(2) } as never);
}

test("adminListAccounts returns every account with project + member counts", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  const accounts = await cp.adminListAccounts({});
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "acc_1");
  assert.equal(accounts[0].projectCount, 1);
  assert.equal(accounts[0].memberCount, 1);
});

test("adminListAccounts filters by plan and query", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  await store.createAccount({ id: "acc_2", name: "Acme Pro", handle: "acme", plan: "pro", createdAt: T(0) });
  assert.deepEqual((await cp.adminListAccounts({ plan: "pro" })).map((a) => a.id), ["acc_2"]);
  assert.deepEqual((await cp.adminListAccounts({ q: "acme" })).map((a) => a.id), ["acc_2"]);
});

test("adminListUsers searches by email/name", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  assert.deepEqual((await cp.adminListUsers({ q: "owner@one" })).map((u) => u.id), ["usr_owner"]);
  assert.equal((await cp.adminListUsers({ q: "nobody" })).length, 0);
});

test("adminListProjects returns all projects, filterable by account + status", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  assert.equal((await cp.adminListProjects({})).length, 1);
  assert.equal((await cp.adminListProjects({ accountId: "acc_1" })).length, 1);
  assert.equal((await cp.adminListProjects({ status: "paused" })).length, 0);
});

test("recordAdminAudit denormalizes the actor email and lists back", async () => {
  const { cp, store } = makeCp();
  await seed(store);
  await store.setUserPlatformRole("usr_owner", "superadmin");

  await cp.recordAdminAudit({
    actorUserId: "usr_owner",
    action: "admin.account.read",
    targetType: "account",
    targetId: "acc_1",
    metadata: { q: "one" },
    ip: "127.0.0.1",
  });

  const events = await cp.listAdminAudit({});
  assert.equal(events.length, 1);
  assert.equal(events[0].actorEmail, "owner@one.com");
  assert.equal(events[0].action, "admin.account.read");
  assert.equal(events[0].targetId, "acc_1");
});

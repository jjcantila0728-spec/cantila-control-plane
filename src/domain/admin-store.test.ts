import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore } from "./store";

function isoAt(n: number): string {
  // Deterministic, monotonically-increasing ISO timestamps for ordering
  // assertions (no Date.now()/Math.random()).
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}

test("setUserPlatformRole sets and clears the role", async () => {
  const store = new InMemoryStore();
  await store.createUser({
    id: "usr_a",
    email: "a@example.com",
    name: "A",
    twoFactorEnabled: false,
    createdAt: isoAt(0),
  });

  const promoted = await store.setUserPlatformRole("usr_a", "superadmin");
  assert.equal(promoted.platformRole, "superadmin");
  assert.equal((await store.getUser("usr_a"))?.platformRole, "superadmin");

  const cleared = await store.setUserPlatformRole("usr_a", null);
  assert.equal(cleared.platformRole, undefined);
});

test("listAllUsers returns every user across tenants, newest first", async () => {
  const store = new InMemoryStore();
  await store.createUser({ id: "usr_1", email: "1@x.com", name: "1", twoFactorEnabled: false, createdAt: isoAt(1) });
  await store.createUser({ id: "usr_2", email: "2@x.com", name: "2", twoFactorEnabled: false, createdAt: isoAt(2) });

  const all = await store.listAllUsers();
  assert.deepEqual(all.map((u) => u.id), ["usr_2", "usr_1"]);
});

test("listAllProjects returns projects across all accounts (incl. platform)", async () => {
  const store = new InMemoryStore();
  await store.createAccount({ id: "acc_1", name: "One", handle: "one", plan: "starter", createdAt: isoAt(0) });
  await store.createAccount({ id: "acc_2", name: "Two", handle: "two", plan: "pro", createdAt: isoAt(0) });
  await store.createProject({ id: "prj_1", accountId: "acc_1", slug: "p1", name: "p1", runtime: "node", region: "fsn1", status: "live", createdAt: isoAt(1) } as never);
  await store.createProject({ id: "prj_2", accountId: "acc_2", slug: "p2", name: "p2", runtime: "node", region: "fsn1", status: "live", createdAt: isoAt(2) } as never);

  const all = await store.listAllProjects();
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((p) => p.accountId)), new Set(["acc_1", "acc_2"]));
});

test("recordAuditLog + listAuditLogs filter and order newest-first", async () => {
  const store = new InMemoryStore();
  await store.recordAuditLog({ id: "aud_1", actorUserId: "usr_a", actorEmail: "a@x.com", action: "admin.account.read", targetType: "account", targetId: "acc_1", metadata: {}, createdAt: isoAt(1) });
  await store.recordAuditLog({ id: "aud_2", actorUserId: "usr_a", actorEmail: "a@x.com", action: "admin.user.list", targetType: "user", metadata: {}, createdAt: isoAt(2) });
  await store.recordAuditLog({ id: "aud_3", actorUserId: "usr_b", actorEmail: "b@x.com", action: "admin.account.read", targetType: "account", targetId: "acc_2", metadata: {}, createdAt: isoAt(3) });

  const all = await store.listAuditLogs({});
  assert.deepEqual(all.map((e) => e.id), ["aud_3", "aud_2", "aud_1"]);

  const byActor = await store.listAuditLogs({ actorUserId: "usr_a" });
  assert.deepEqual(byActor.map((e) => e.id), ["aud_2", "aud_1"]);

  const byAction = await store.listAuditLogs({ action: "admin.account.read" });
  assert.deepEqual(byAction.map((e) => e.id), ["aud_3", "aud_1"]);
});

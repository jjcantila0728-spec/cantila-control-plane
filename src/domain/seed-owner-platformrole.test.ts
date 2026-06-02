import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore } from "./store";
import { seedOwnerAccount } from "./seed-owner";

test("seedOwnerAccount promotes the owner to superadmin", async () => {
  const store = new InMemoryStore();
  const result = await seedOwnerAccount(store, {
    email: "founder@example.com",
    password: "correct horse battery staple",
    name: "Founder",
    accountId: "acc_cantila",
    accountName: "Cantila",
    handle: "cantila",
    plan: "dedicated",
  });
  const user = await store.getUser(result.userId);
  assert.equal(user?.platformRole, "superadmin");
});

test("seedOwnerAccount is idempotent on platformRole (re-run keeps superadmin)", async () => {
  const store = new InMemoryStore();
  const input = {
    email: "founder@example.com",
    password: "pw",
    name: "Founder",
    accountId: "acc_cantila",
    accountName: "Cantila",
    handle: "cantila",
    plan: "dedicated" as const,
  };
  const first = await seedOwnerAccount(store, input);
  await seedOwnerAccount(store, input);
  assert.equal((await store.getUser(first.userId))?.platformRole, "superadmin");
});

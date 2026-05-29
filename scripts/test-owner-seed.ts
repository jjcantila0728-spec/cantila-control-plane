/* ============================================================
   Test — owner-account boot seed (scripts/test-owner-seed.ts)

   Run: npx tsx scripts/test-owner-seed.ts

   Proves `seedOwnerAccount` makes a given email a real OWNER of a
   real account (not the acc_demo fallback), so that mintSession —
   which scopes a fresh session to `listMembershipsByUser(...)[0]` —
   resolves the owner to their own account on login. Idempotent so
   it is safe to run on every boot and against a live process.

   Uses a throwaway password; the real owner credential lives in
   .env (CANTILA_OWNER_PASSWORD), never in source.
   ============================================================ */

import assert from "node:assert/strict";
import { InMemoryStore } from "../src/domain/store";
import { verifyPassword } from "../src/auth/passwords";
import { seedOwnerAccount } from "../src/domain/seed-owner";

const INPUT = {
  email: "owner@example.test",
  password: "test-password-123",
  name: "Test Owner",
  accountId: "acc_cantila",
  accountName: "Cantila",
  handle: "cantila",
  plan: "dedicated" as const,
};

async function freshSeedCreatesOwnerOfRealAccount() {
  const store = new InMemoryStore();
  const result = await seedOwnerAccount(store, INPUT);

  // account
  const account = await store.getAccount("acc_cantila");
  assert.ok(account, "account acc_cantila should exist");
  assert.equal(account!.name, "Cantila");
  assert.equal(account!.handle, "cantila");
  assert.equal(account!.plan, "dedicated");

  // user + password + verified
  const user = await store.findUserByEmail("owner@example.test");
  assert.ok(user, "owner user should exist");
  assert.ok(
    verifyPassword("test-password-123", user!.passwordHash ?? ""),
    "seeded password should verify",
  );
  assert.ok(user!.emailVerifiedAt, "owner email should be marked verified");

  // membership — must be the FIRST membership so mintSession scopes to it
  const memberships = await store.listMembershipsByUser(user!.id);
  assert.equal(memberships.length, 1, "owner should have exactly one membership");
  assert.equal(
    memberships[0].accountId,
    "acc_cantila",
    "first membership must be the owner account (mintSession scopes to [0])",
  );
  assert.equal(memberships[0].role, "owner", "role must be owner");

  assert.deepEqual(result.created, {
    account: true,
    user: true,
    membership: true,
    passwordSet: true,
  });
  console.log("✓ fresh seed creates owner of a real account");
}

async function isIdempotent() {
  const store = new InMemoryStore();
  await seedOwnerAccount(store, INPUT);
  const second = await seedOwnerAccount(store, INPUT);

  const user = await store.findUserByEmail("owner@example.test");
  const memberships = await store.listMembershipsByUser(user!.id);
  assert.equal(memberships.length, 1, "second run must not duplicate membership");
  assert.deepEqual(
    second.created,
    { account: false, user: false, membership: false, passwordSet: false },
    "second run should create nothing",
  );
  console.log("✓ seed is idempotent");
}

async function backfillsPasswordForExistingSsoUser() {
  // Mirrors the real bug scenario: the owner auto-registered via login
  // with NO password set and NO membership, falling back to acc_demo.
  const store = new InMemoryStore();
  await store.createUser({
    id: "usr_preexisting",
    email: "owner@example.test",
    name: "Test Owner",
    twoFactorEnabled: false,
    createdAt: new Date().toISOString(),
  });

  const result = await seedOwnerAccount(store, INPUT);

  const user = await store.findUserByEmail("owner@example.test");
  assert.equal(user!.id, "usr_preexisting", "should reuse the existing user row");
  assert.ok(
    verifyPassword("test-password-123", user!.passwordHash ?? ""),
    "password should be backfilled onto the existing user",
  );
  const memberships = await store.listMembershipsByUser("usr_preexisting");
  assert.equal(memberships[0].accountId, "acc_cantila");
  assert.equal(memberships[0].role, "owner");
  assert.deepEqual(result.created, {
    account: true,
    user: false,
    membership: true,
    passwordSet: true,
  });
  console.log("✓ seed backfills password + owner membership for a pre-existing user");
}

async function main() {
  await freshSeedCreatesOwnerOfRealAccount();
  await isIdempotent();
  await backfillsPasswordForExistingSsoUser();
  console.log("\nALL OWNER-SEED TESTS PASSED");
}

main().catch((err) => {
  console.error("\nOWNER-SEED TEST FAILED:");
  console.error(err);
  process.exit(1);
});

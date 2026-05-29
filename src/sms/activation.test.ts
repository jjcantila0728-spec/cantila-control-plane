/* ============================================================
   Opt-in SMS activation (plan §4.5).
   SMS is no longer auto-wired at deploy — a tenant activates it on a
   project, which provisions a real number (the stub carrier here) and
   bridges it to the project's send path. These tests exercise the
   in-memory store + stub provisioner/dataplane/stripe, so they run
   fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { provisionProjectServices } from "../deploy/provisioning";

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
  const project = await cp.createProject({
    accountId: "acc_test",
    name: "demo",
    runtime: "node",
    region: "ash",
  });
  return project;
}

test("deploy no longer auto-provisions an SMS number", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const result = await provisionProjectServices(
    store,
    stubProvisioner,
    await store.getProject(project.id).then((p) => p!),
  );

  assert.equal(result.databaseCreated, true);
  assert.equal(result.mailboxCreated, true);
  // No phone number, and no CANTILA_SMS_* env injected.
  assert.equal(await store.getPhoneNumberByProject(project.id), null);
  const env = await store.listEnvVars(project.id);
  assert.equal(env.some((e) => e.key.startsWith("CANTILA_SMS")), false);
});

test("sendSms fails before activation, succeeds after", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const before = await cp.sendSms(project.id, { to: "+15551230000", body: "hi" });
  assert.deepEqual(before, { error: "project has no phone number" });

  const activated = await cp.activateSms("acc_test", project.id, { country: "US" });
  assert.ok(!("error" in activated), "activation should succeed");

  const after = await cp.sendSms(project.id, { to: "+15551230000", body: "hi" });
  assert.ok(!("error" in after), "send should succeed once SMS is active");
});

test("activateSms provisions a number, marketplace row, and env", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const phone = await cp.activateSms("acc_test", project.id, {
    country: "US",
    numberType: "local",
  });
  assert.ok(!("error" in phone), "activation should succeed");

  // Project number exists and is linked to a marketplace number.
  const stored = await store.getPhoneNumberByProject(project.id);
  assert.ok(stored, "a project PhoneNumber should exist");
  assert.ok(stored!.marketplaceNumberId, "linked to a MarketplaceNumber");

  // An account-owned marketplace number assigned to this project.
  const owned = await store.listMarketplaceNumbers("acc_test");
  const mine = owned.find((n) => n.id === stored!.marketplaceNumberId);
  assert.ok(mine, "MarketplaceNumber persisted");
  assert.equal(mine!.projectId, project.id);
  assert.equal(mine!.status, "active");

  // Both env vars injected.
  const env = await store.listEnvVars(project.id);
  assert.ok(env.find((e) => e.key === "CANTILA_SMS_NUMBER"));
  assert.ok(env.find((e) => e.key === "CANTILA_SMS_API_KEY"));
});

test("activateSms is idempotent", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const first = await cp.activateSms("acc_test", project.id, { country: "US" });
  const second = await cp.activateSms("acc_test", project.id, { country: "US" });
  assert.ok(!("error" in first) && !("error" in second));
  assert.equal((first as { e164: string }).e164, (second as { e164: string }).e164);

  // Only one marketplace number was provisioned.
  const owned = await store.listMarketplaceNumbers("acc_test");
  assert.equal(owned.filter((n) => n.status === "active").length, 1);
});

test("deactivateSms releases the number, strips env, and is idempotent", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const phone = await cp.activateSms("acc_test", project.id, { country: "US" });
  assert.ok(!("error" in phone));
  const marketplaceId = (
    await store.getPhoneNumberByProject(project.id)
  )!.marketplaceNumberId!;

  const off = await cp.deactivateSms("acc_test", project.id);
  assert.deepEqual(off, { ok: true });

  // Project number gone.
  assert.equal(await store.getPhoneNumberByProject(project.id), null);
  // Marketplace number released.
  const released = await store.getMarketplaceNumber(marketplaceId);
  assert.equal(released!.status, "released");
  // Env stripped.
  const env = await store.listEnvVars(project.id);
  assert.equal(env.some((e) => e.key.startsWith("CANTILA_SMS")), false);

  // Idempotent — deactivating again is a no-op.
  const again = await cp.deactivateSms("acc_test", project.id);
  assert.deepEqual(again, { ok: true });
});

test("activate/deactivate reject a project on another account", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const wrong = await cp.activateSms("acc_other", project.id, { country: "US" });
  assert.deepEqual(wrong, { error: "project not found" });

  const wrongOff = await cp.deactivateSms("acc_other", project.id);
  assert.deepEqual(wrongOff, { error: "project not found" });
});

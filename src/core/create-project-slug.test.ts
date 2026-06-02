/* ============================================================
   createProject — subdomain (slug) uniqueness.
   Two projects whose names slugify to the same base must NOT
   both claim `<slug>.cantila.app`; the second gets a numeric
   suffix so every project keeps a distinct live URL.
   ============================================================ */

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

async function seedAccount(store: InMemoryStore) {
  await store.createAccount({
    id: "acc_test",
    name: "Test",
    handle: "test",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
}

test("first project gets the bare slug + matching domain", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const p = await cp.createProject({
    accountId: "acc_test",
    name: "Cantila Homes",
    runtime: "node",
    region: "fsn1",
  });
  assert.equal(p.slug, "cantila-homes");
  assert.ok(await store.findDomainByHostname("cantila-homes.cantila.app"));
});

test("second project with the same name gets a -2 suffix (distinct URL)", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const a = await cp.createProject({
    accountId: "acc_test",
    name: "Cantila Homes",
    runtime: "node",
    region: "fsn1",
  });
  const b = await cp.createProject({
    accountId: "acc_test",
    name: "Cantila Homes",
    runtime: "node",
    region: "fsn1",
  });
  assert.equal(a.slug, "cantila-homes");
  assert.equal(b.slug, "cantila-homes-2");
  // Each project owns its own, distinct subdomain row.
  assert.ok(await store.findDomainByHostname("cantila-homes.cantila.app"));
  assert.ok(await store.findDomainByHostname("cantila-homes-2.cantila.app"));
});

test("third collision keeps incrementing the suffix", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const slugs: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await cp.createProject({
      accountId: "acc_test",
      name: "homes",
      runtime: "node",
      region: "fsn1",
    });
    slugs.push(p.slug);
  }
  assert.deepEqual(slugs, ["homes", "homes-2", "homes-3"]);
});

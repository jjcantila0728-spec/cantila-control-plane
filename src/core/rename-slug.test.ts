/* ============================================================
   renameSlug — change a project's subdomain.
   Changing the slug rewrites the project's primary
   `<slug>.cantila.app` subdomain row in place and must keep
   the global one-subdomain-per-project invariant: a slug
   already claimed by another project is rejected.
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

async function makeProject(cp: ControlPlane, name: string) {
  return cp.createProject({
    accountId: "acc_test",
    name,
    runtime: "node",
    region: "fsn1",
  });
}

test("renameSlug updates the slug and rewrites the subdomain row in place", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const p = await makeProject(cp, "Cantila Homes");
  assert.equal(p.slug, "cantila-homes");

  const result = await cp.renameSlug(p.id, "homes-prod");
  assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
  assert.equal((result as { slug: string }).slug, "homes-prod");

  // New subdomain resolves, old one is gone (rewritten in place, no orphan).
  assert.ok(await store.findDomainByHostname("homes-prod.cantila.app"));
  assert.equal(await store.findDomainByHostname("cantila-homes.cantila.app"), null);

  // Exactly one subdomain row for the project, still primary.
  const domains = await store.listDomains(p.id);
  const subs = domains.filter((d) => d.kind === "subdomain");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].hostname, "homes-prod.cantila.app");
  assert.equal(subs[0].primary, true);
});

test("renameSlug normalises the input via slugify", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const p = await makeProject(cp, "Cantila Homes");

  const result = await cp.renameSlug(p.id, "  Homes Prod!! ");
  assert.ok(!("error" in result));
  assert.equal((result as { slug: string }).slug, "homes-prod");
  assert.ok(await store.findDomainByHostname("homes-prod.cantila.app"));
});

test("renameSlug rejects a slug already claimed by another project", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const a = await makeProject(cp, "Alpha");
  const b = await makeProject(cp, "Beta");

  const result = await cp.renameSlug(b.id, a.slug);
  assert.ok("error" in result);
  // Beta keeps its own slug; Alpha's subdomain is untouched.
  const fresh = await store.getProject(b.id);
  assert.equal(fresh?.slug, "beta");
});

test("renameSlug rejects an unchanged slug", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const p = await makeProject(cp, "Cantila Homes");

  const result = await cp.renameSlug(p.id, "cantila-homes");
  assert.ok("error" in result);
});

test("renameSlug rejects an empty / invalid slug", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const p = await makeProject(cp, "Cantila Homes");

  const result = await cp.renameSlug(p.id, "!!!");
  assert.ok("error" in result);
  // Subdomain unchanged.
  assert.ok(await store.findDomainByHostname("cantila-homes.cantila.app"));
});

test("renameSlug 404s for an unknown project", async () => {
  const { cp, store } = makeCp();
  await seedAccount(store);
  const result = await cp.renameSlug("prj_does_not_exist", "whatever");
  assert.ok("error" in result);
});

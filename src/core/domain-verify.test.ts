/* ============================================================
   Domain verify sweep (plan §22.6 — bring-your-own-domain).
   Once a customer points their DNS (CNAME → <slug>.cantila.app) at the
   platform and the data plane's Traefik issues the Let's Encrypt cert,
   the host becomes reachable over HTTPS. runDomainVerifySweep() probes
   each pending custom domain and flips Domain.sslActive once the host
   answers over TLS, recording a "domain is live" activity event.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp(liveHosts: Set<string>): {
  cp: ControlPlane;
  store: InMemoryStore;
} {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
    // Inject a deterministic reachability probe so the sweep is testable
    // without real DNS / HTTPS.
    domainProbe: async (hostname: string) => liveHosts.has(hostname),
  });
  return { cp, store };
}

async function seedProjectWithDomain(
  cp: ControlPlane,
  store: InMemoryStore,
  hostname: string,
) {
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
    region: "fsn1",
  });
  await cp.addDomain(project.id, hostname);
  return project;
}

test("verify sweep flips sslActive once the custom host answers over HTTPS", async () => {
  const { cp, store } = makeCp(new Set(["app.acme.com"]));
  const project = await seedProjectWithDomain(cp, store, "app.acme.com");

  const result = await cp.runDomainVerifySweep();

  assert.deepEqual(result, { checked: 1, verified: 1 });
  const custom = (await store.listDomains(project.id)).find(
    (d) => d.hostname === "app.acme.com",
  );
  assert.equal(custom!.sslActive, true, "domain should be marked SSL-active");
});

test("verify sweep leaves an unreachable custom host pending", async () => {
  const { cp, store } = makeCp(new Set()); // nothing reachable yet
  const project = await seedProjectWithDomain(cp, store, "app.acme.com");

  const result = await cp.runDomainVerifySweep();

  assert.deepEqual(result, { checked: 1, verified: 0 });
  const custom = (await store.listDomains(project.id)).find(
    (d) => d.hostname === "app.acme.com",
  );
  assert.equal(custom!.sslActive, false, "domain should stay pending");
});

test("verify sweep ignores free *.cantila.app subdomains", async () => {
  const { cp, store } = makeCp(new Set(["extra.cantila.app"]));
  // A cantila subdomain is issued immediately (sslActive true), so it is
  // never pending and the sweep must not even probe it.
  await seedProjectWithDomain(cp, store, "extra.cantila.app");

  const result = await cp.runDomainVerifySweep();
  assert.equal(result.checked, 0, "subdomains must not be in the pending set");
});

test("verify sweep records a domain-live event on success", async () => {
  const { cp, store } = makeCp(new Set(["app.acme.com"]));
  const project = await seedProjectWithDomain(cp, store, "app.acme.com");

  await cp.runDomainVerifySweep();

  const events = await store.listEvents(project.accountId);
  assert.ok(
    events.some((e) => e.kind === "domain" && /app\.acme\.com/.test(e.title)),
    "expected a domain activity event mentioning the host",
  );
});

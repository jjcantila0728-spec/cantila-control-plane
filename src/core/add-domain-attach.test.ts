/* ============================================================
   addDomain → data-plane attach wiring (plan §22.6).
   When a customer attaches a custom hostname, the control plane must
   ask the data plane to wire it onto the running app (so Traefik routes
   it and requests a cert). Free *.cantila.app subdomains are
   wildcard-covered and need no per-host attach. Attach is best-effort:
   a data-plane failure must not fail the user's addDomain call — the
   verify sweep retries later.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import type { DataPlane } from "../deploy/pipeline";
import type { Project } from "../domain/types";

function makeCp(attach: DataPlane["attachDomain"]): {
  cp: ControlPlane;
  store: InMemoryStore;
  calls: { hostname: string }[];
} {
  const calls: { hostname: string }[] = [];
  const dataPlane: DataPlane = {
    ...stubDataPlane,
    attachDomain: async (project: Project, hostname: string) => {
      calls.push({ hostname });
      return attach ? attach(project, hostname) : undefined;
    },
  };
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store, calls };
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

test("addDomain wires a custom host onto the data plane", async () => {
  const { cp, store, calls } = makeCp(undefined);
  const project = await seedProject(cp, store);

  const result = await cp.addDomain(project.id, "app.acme.com");

  assert.ok(!("error" in result), "addDomain should succeed");
  assert.deepEqual(
    calls.map((c) => c.hostname),
    ["app.acme.com"],
    "attachDomain should be called once with the custom host",
  );
});

test("addDomain does not attach for a free *.cantila.app subdomain", async () => {
  const { cp, store, calls } = makeCp(undefined);
  const project = await seedProject(cp, store);

  await cp.addDomain(project.id, "extra.cantila.app");

  assert.equal(calls.length, 0, "subdomains are wildcard-covered, no attach");
});

test("addDomain still succeeds when the data-plane attach fails", async () => {
  const { cp, store } = makeCp(async () => {
    throw new Error("coolify down");
  });
  const project = await seedProject(cp, store);

  const result = await cp.addDomain(project.id, "app.acme.com");

  assert.ok(!("error" in result), "attach failure must not fail addDomain");
  const [domain] = (await store.listDomains(project.id)).filter(
    (d) => d.hostname === "app.acme.com",
  );
  assert.ok(domain, "the domain row is still created");
  assert.equal(domain!.sslActive, false, "still pending until verified");
});

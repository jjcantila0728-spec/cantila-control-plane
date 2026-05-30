/* ============================================================
   ensureProjectRepo — auto-provision a Cantila repo for a
   repo-less project, idempotently. In-memory store + stub
   provider, fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
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

test("ensureProjectRepo provisions a cantila repo for a repo-less project, idempotently", async () => {
  const { cp, store } = makeCp();
  await store.createAccount({
    id: "acc_test",
    name: "Cantila",
    handle: "cantila",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  const project = await cp.createProject({
    accountId: "acc_test",
    name: "Homes",
    runtime: "node",
    region: "fsn1",
  });
  assert.ok(!project.repoUrl, "fixture project must start repo-less");

  const first = await cp.ensureProjectRepo(project.id);
  assert.ok(first && first.repoHost === "cantila");
  assert.ok(first.repoUrl && first.repoUrl.length > 0);

  const second = await cp.ensureProjectRepo(project.id);
  assert.ok(second);
  assert.equal(second.repoUrl, first.repoUrl);
});

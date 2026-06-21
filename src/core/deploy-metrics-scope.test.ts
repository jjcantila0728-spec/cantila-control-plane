/* ============================================================
   getDeployMetrics — account isolation (offline, stubs).
   The deploy-health endpoint must aggregate ONLY the caller's own
   deployments. This guards the tenant boundary on the new
   /v1/deploy/metrics route.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import type { Deployment } from "../domain/types";

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

async function seedAccountWithProject(
  cp: ControlPlane,
  store: InMemoryStore,
  accId: string,
) {
  await store.createAccount({
    id: accId,
    name: accId,
    handle: accId,
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  return cp.createProject({
    accountId: accId,
    name: `${accId}-demo`,
    runtime: "node",
    region: "fsn1",
  });
}

function dep(projectId: string, status: Deployment["status"], logs: string[]): Deployment {
  return {
    id: `dep_${Math.round(Math.random() * 1e9)}`,
    projectId,
    status,
    trigger: "chat",
    runtime: "node",
    logs,
    createdAt: new Date().toISOString(),
  };
}

test("getDeployMetrics counts only the caller's own account deployments", async () => {
  const { cp, store } = makeCp();
  const a = await seedAccountWithProject(cp, store, "acc_a");
  const b = await seedAccountWithProject(cp, store, "acc_b");

  // acc_a: 2 live, 1 failed (build). acc_b: 1 failed (health) — must not leak.
  await store.createDeployment(dep(a.id, "live", []));
  await store.createDeployment(dep(a.id, "live", []));
  await store.createDeployment(dep(a.id, "failed", ["build-failed:x"]));
  await store.createDeployment(dep(b.id, "failed", ["verify-failed:crash"]));

  const m = await cp.getDeployMetrics("acc_a");
  assert.equal(m.live, 2);
  assert.equal(m.failed, 1);
  assert.equal(m.successRatePct, Math.round((2 / 3) * 1000) / 10);
  assert.deepEqual(m.byFailureReason, { build_failed: 1 });
  // acc_b's health failure must be absent from acc_a's view.
  assert.equal(m.byFailureReason.health_check_failed, undefined);

  const mb = await cp.getDeployMetrics("acc_b");
  assert.equal(mb.failed, 1);
  assert.deepEqual(mb.byFailureReason, { health_check_failed: 1 });
});

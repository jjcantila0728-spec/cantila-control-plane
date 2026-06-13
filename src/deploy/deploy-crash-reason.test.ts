/* ============================================================
   A failed health check must record WHY the container is unhealthy
   (Feature C) — the deploy's step trace carries `verify-failed:<reason>`
   so the deploying agent (cantila_get_logs / troubleshoot / the
   DeployOutcome it gets back) can see the runtime crash reason instead
   of an opaque "verify-failed".
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import type { DataPlane } from "./pipeline";

function makeCp(dataPlane: DataPlane): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

async function seedAndConnect(cp: ControlPlane, store: InMemoryStore) {
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
  await cp.connectGit(project.id, {
    repoUrl: "https://github.com/owner/demo",
    branch: "main",
  });
  return project;
}

test("a failed health check records the crash reason in the step trace", async () => {
  const dp: DataPlane = {
    ...stubDataPlane,
    healthCheck: async () => false,
    diagnoseCrash: async () =>
      "health check got no 200 · container status=exited · logs: Error: connect ECONNREFUSED",
  };
  const { cp, store } = makeCp(dp);
  const project = await seedAndConnect(cp, store);

  const outcome = await cp.deploy(project.id, {
    trigger: "mcp",
    source: { kind: "git" },
  });

  assert.equal(outcome.status, "failed");
  const verify = outcome.steps.find((s) => s.startsWith("verify-failed"));
  assert.ok(verify, "expected a verify-failed step");
  assert.ok(
    verify!.includes("container status=exited"),
    `crash reason missing from step: ${verify}`,
  );
});

test("a failed health check with no diagnosis still emits a bare verify-failed", async () => {
  const dp: DataPlane = {
    ...stubDataPlane,
    healthCheck: async () => false,
    // no diagnoseCrash — older data planes (the stub) don't implement it
  };
  const { cp, store } = makeCp(dp);
  const project = await seedAndConnect(cp, store);

  const outcome = await cp.deploy(project.id, {
    trigger: "mcp",
    source: { kind: "git" },
  });

  assert.equal(outcome.status, "failed");
  assert.ok(
    outcome.steps.includes("verify-failed"),
    `expected bare verify-failed, got: ${outcome.steps.join(", ")}`,
  );
});

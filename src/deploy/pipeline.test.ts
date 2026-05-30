/* ============================================================
   runDeploy — no-source guard (Fix 3b).
   A git deploy with no connected repository must fail loudly rather
   than fall through to the nginx placeholder and report "live".
   Uses the in-memory store + stubs, fully offline.
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

test("git deploy with no connected repo fails loudly", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  await assert.rejects(
    () => cp.deploy(project.id, { trigger: "cli", source: { kind: "git" } }),
    /no git source connected/,
  );
});

test("git deploy succeeds once a repo is connected", async () => {
  const { cp, store } = makeCp();
  const project = await seedProject(cp, store);

  const connected = await cp.connectGit(project.id, {
    repoUrl: "https://github.com/owner/demo",
    branch: "main",
  });
  assert.ok(!("error" in connected), "connectGit should succeed");

  const outcome = await cp.deploy(project.id, {
    trigger: "cli",
    source: { kind: "git" },
  });
  // Stub data plane reports the app healthy → live.
  assert.equal(outcome.status, "live");
});

/* ============================================================
   The built-in database must be MIGRATED before the app goes live.
   Provisioning a fresh Postgres + injecting DATABASE_URL is not enough:
   if the tenant's schema is never applied, every query throws P2021
   ("table does not exist") and the app boots "live but broken".

   The deploy pipeline runs `dataPlane.runMigration` after the image is
   built and gates on it:
     - migration fails  → deploy fails with `migrate-failed:<reason>`,
                           the container is NEVER started, status=failed.
     - migration ok     → emits `migrated`, deploy proceeds to live.
     - no runMigration  → backward-compatible: deploy proceeds (older
                           data planes that don't implement it still work).
   In-memory store + stubs, fully offline.
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

test("a failed migration fails the deploy and never starts the container", async () => {
  let startCalled = false;
  const dp: DataPlane = {
    ...stubDataPlane,
    runMigration: async () => ({
      ok: false,
      log: "Error: P3009 migrate found failed migrations: relation \"User\" does not exist",
    }),
    startContainer: async () => {
      startCalled = true;
    },
  };
  const { cp, store } = makeCp(dp);
  const project = await seedAndConnect(cp, store);

  const outcome = await cp.deploy(project.id, {
    trigger: "mcp",
    source: { kind: "git" },
  });

  assert.equal(outcome.status, "failed", "deploy must fail when migration fails");
  assert.equal(startCalled, false, "container must NOT start after a failed migration");

  const migrate = outcome.steps.find((s) => s.startsWith("migrate-failed"));
  assert.ok(migrate, `expected a migrate-failed step, got: ${outcome.steps.join(", ")}`);
  assert.ok(
    migrate!.includes("P3009"),
    `migration reason missing from step: ${migrate}`,
  );

  // The project must be marked crashed, not left "building" or "live".
  const after = await store.getProject(project.id);
  assert.equal(after!.status, "crashed");
});

test("a successful migration emits `migrated` and the deploy goes live", async () => {
  const order: string[] = [];
  const dp: DataPlane = {
    ...stubDataPlane,
    runMigration: async () => {
      order.push("migrate");
      return { ok: true };
    },
    startContainer: async () => {
      order.push("start");
    },
  };
  const { cp, store } = makeCp(dp);
  const project = await seedAndConnect(cp, store);

  const outcome = await cp.deploy(project.id, {
    trigger: "mcp",
    source: { kind: "git" },
  });

  assert.equal(outcome.status, "live");
  assert.ok(
    outcome.steps.includes("migrated"),
    `expected a migrated step, got: ${outcome.steps.join(", ")}`,
  );
  // Migration must run BEFORE the container starts.
  assert.deepEqual(order, ["migrate", "start"]);
});

test("a data plane without runMigration still deploys (backward compatible)", async () => {
  // stubDataPlane has no runMigration — older planes must keep working.
  const { cp, store } = makeCp(stubDataPlane);
  const project = await seedAndConnect(cp, store);

  const outcome = await cp.deploy(project.id, {
    trigger: "mcp",
    source: { kind: "git" },
  });

  assert.equal(outcome.status, "live");
  assert.ok(
    !outcome.steps.some((s) => s.startsWith("migrat")),
    `expected no migration step, got: ${outcome.steps.join(", ")}`,
  );
});

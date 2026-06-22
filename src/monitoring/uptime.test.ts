/* ============================================================
   UptimeChecker — status reconciliation (GUIDE-project-status-
   reconciliation.md). The sweep already health-checks every
   project; it must converge a stuck non-terminal status toward
   observed reality so a project whose deploy died mid-build (and
   thus is frozen at "building") self-heals to "live" once its
   domain is serving. Deliberate states (paused/sleeping) and
   in-flight builds (building + unhealthy) are never overridden.
   In-memory store + a controllable health stub, fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

// Pin the owner account the sweep scans to a test-local id.
process.env.CANTILA_OWNER_ACCOUNT_ID = "acc_uptime_test";

import { UptimeChecker } from "./uptime";
import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import type { ProjectStatus } from "../domain/types";

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

async function seedProject(
  cp: ControlPlane,
  store: InMemoryStore,
  status: ProjectStatus,
): Promise<string> {
  await store.createAccount({
    id: "acc_uptime_test",
    name: "Test",
    handle: "test",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  const p = await cp.createProject({
    accountId: "acc_uptime_test",
    name: "demo",
    runtime: "node",
    region: "fsn1",
  });
  await store.updateProject(p.id, { status });
  return p.id;
}

/** A UptimeChecker wired to a health stub with a fixed answer. */
function makeChecker(store: InMemoryStore, healthy: boolean): UptimeChecker {
  const dataPlane = { healthCheck: async () => healthy } as never;
  return new UptimeChecker({ store, dataPlane });
}

test("stuck 'building' + healthy domain → reconciled to 'live'", async () => {
  const { cp, store } = makeCp();
  const id = await seedProject(cp, store, "building");

  await makeChecker(store, true).sweep();

  assert.equal((await store.getProject(id))!.status, "live");
});

test("'provisioning' + healthy domain → reconciled to 'live'", async () => {
  const { cp, store } = makeCp();
  const id = await seedProject(cp, store, "provisioning");

  await makeChecker(store, true).sweep();

  assert.equal((await store.getProject(id))!.status, "live");
});

test("'building' + unhealthy domain → left untouched (build in flight)", async () => {
  const { cp, store } = makeCp();
  const id = await seedProject(cp, store, "building");

  await makeChecker(store, false).sweep();

  assert.equal((await store.getProject(id))!.status, "building");
});

test("deliberate 'paused' + healthy domain → never overridden", async () => {
  const { cp, store } = makeCp();
  const id = await seedProject(cp, store, "paused");

  await makeChecker(store, true).sweep();

  assert.equal((await store.getProject(id))!.status, "paused");
});

test("'sleeping' + healthy domain → never overridden", async () => {
  const { cp, store } = makeCp();
  const id = await seedProject(cp, store, "sleeping");

  await makeChecker(store, true).sweep();

  assert.equal((await store.getProject(id))!.status, "sleeping");
});

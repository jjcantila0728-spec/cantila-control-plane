import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectOrchestrator, type OrchestratorEvent } from "./project-orchestrator";

const planner = { async plan() { return { name: "shop", stack: "Next.js", summary: "a shop", kind: "live_app", runtime: "node", region: "fsn1", services: { needsDatabase: false, needsMail: false, needsSms: false }, buildPlan: [], media: { logo: false, hero: false, favicon: false, iconSet: false, heroAnimation: false, socialOgImage: false } }; } };
const images = { async generateImage() { return { dataUrl: "x", mimeType: "image/svg+xml", width: 1, height: 1, provider: "fake" }; }, async generateAnimation() { return { content: "{}", mode: "lottie" as const, mimeType: "application/json", provider: "fake" }; } };

function fakeQuery() {
  return async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "page.tsx" } }] } };
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "done" };
  };
}

test("runBuild delegates to the fleet, streams result+done, persists messages", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const events: OrchestratorEvent[] = [];
  const orch = new ProjectOrchestrator({ cp: {} as any, planner: planner as any, images: images as any, fleet: { query: fakeQuery() as any, workspaceRoot: root } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "result"));
  assert.equal(events.at(-1)!.kind, "done");
  assert.ok(orch.listMessages("p1").length > 0, "messages persisted");
});

test("runChat persists the user message and streams a done", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const events: OrchestratorEvent[] = [];
  const orch = new ProjectOrchestrator({ cp: {} as any, planner: planner as any, images: images as any, fleet: { query: fakeQuery() as any, workspaceRoot: root } } as any);
  await orch.runChat({ projectId: "p2", message: "add a footer", onEvent: (e) => events.push(e) });
  assert.equal(events.at(-1)!.kind, "done");
  const msgs = orch.listMessages("p2");
  assert.ok(msgs.some((m) => m.role === "user" && /footer/.test(m.content)), "user message persisted");
});

function fakeQueryOk() {
  return (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "FLEET_BUILD_RESULT: ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
}

test("autodeploy OFF: bridge not invoked even on buildOk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; delete process.env.FLEET_AUTODEPLOY;
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: "acc" }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x" }; } } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 0);
  if (prev !== undefined) process.env.FLEET_AUTODEPLOY = prev;
});

test("autodeploy ON + buildOk + owner account: bridge invoked once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; process.env.FLEET_AUTODEPLOY = "on";
  const { ownerAccountId } = await import("../lib/owner-account");
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: ownerAccountId() }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x", liveUrl: "https://x.cantila.app" }; } } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 1);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});

test("autodeploy ON + buildOk + NON-owner account: bridge NOT invoked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; process.env.FLEET_AUTODEPLOY = "on";
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: "some-other-acct" }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x" }; } } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 0);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});

test("sandbox FAIL blocks deploy even when buildOk + autodeploy + owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; process.env.FLEET_AUTODEPLOY = "on";
  const { ownerAccountId } = await import("../lib/owner-account");
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: ownerAccountId() }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x" }; } }, sandbox: { run: async () => ({ passed: false, detail: "did not boot", logs: "", durationMs: 1 }) } } as any);
  const events: OrchestratorEvent[] = [];
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: (e) => events.push(e) });
  assert.equal(bridgeCalls, 0, "broken build must not deploy");
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});

test("sandbox PASS allows deploy (buildOk + autodeploy + owner)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; process.env.FLEET_AUTODEPLOY = "on";
  const { ownerAccountId } = await import("../lib/owner-account");
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: ownerAccountId() }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x", liveUrl: "https://x.cantila.app" }; } }, sandbox: { run: async () => ({ passed: true, detail: "booted; HTTP 200", logs: "", durationMs: 1 }) } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 1);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});

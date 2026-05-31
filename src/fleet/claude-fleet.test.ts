import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeFleet } from "./claude-fleet";
import { FleetSessionRegistry } from "./session-registry";
import type { OrchestratorEvent } from "../agents/project-orchestrator";
import { BudgetGovernor } from "./budget";

const plan = { name: "shop", stack: "Next.js", summary: "a shop", kind: "live_app" } as any;

function fakeQuery(capture: { options?: any }) {
  return async function* ({ options }: any) {
    capture.options = options;
    yield { type: "system", subtype: "init" };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Building." }] } };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "page.tsx" } }] } };
    yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "wrote page.tsx" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, result: "done" };
  };
}

test("build streams events and passes safe options to query", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const cap: { options?: any } = {};
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: fakeQuery(cap) as unknown as import("./sdk").QueryFn, workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p1", plan, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "agent_message"));
  assert.ok(events.some((e) => e.kind === "op_started"));
  assert.ok(events.some((e) => e.kind === "result"));
  assert.equal(events.at(-1)!.kind, "done");
  assert.equal(cap.options.permissionMode, "dontAsk");
  assert.equal(cap.options.cwd, path.resolve(root, "p1", "workspace"));
  assert.ok(cap.options.maxTurns >= 1 && cap.options.maxBudgetUsd > 0);
  assert.ok(Array.isArray(cap.options.disallowedTools) && cap.options.disallowedTools.length > 0);
  assert.ok(cap.options.agents && Object.keys(cap.options.agents).length > 0);
});

test("offline (null query) emits a message + done, no fake success", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: null, workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p2", plan, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "agent_message" && /offline|ANTHROPIC/i.test((e as any).content)));
  assert.equal(events.at(-1)!.kind, "done");
  assert.ok(!events.some((e) => e.kind === "result"));
});

test("stream ending without a result message still emits exactly one done", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const events: OrchestratorEvent[] = [];
  const q = (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "working" }] } };
    // stream ends with NO result message
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p3", plan, onEvent: (e) => events.push(e) });
  const dones = events.filter((e) => e.kind === "done");
  assert.equal(dones.length, 1, "exactly one done");
});

test("query that throws emits error then exactly one done", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const events: OrchestratorEvent[] = [];
  const q = (() => async function* () { throw new Error("boom"); })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() });
  await fleet.build({ projectId: "p4", plan, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.kind === "error"));
  assert.equal(events.filter((e) => e.kind === "done").length, 1);
});

test("build is blocked (no query call) when the daily budget is exhausted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  let calls = 0;
  const gov = new BudgetGovernor({ capUsd: 1 });
  gov.record(1); // at cap → blocked
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: (() => { calls++; return (async function* () {})(); }) as any, workspaceRoot: root, registry: new FleetSessionRegistry(), governor: gov } as any);
  await fleet.build({ projectId: "pb", plan, onEvent: (e) => events.push(e) });
  assert.equal(calls, 0, "query must not be called when over budget");
  assert.ok(events.some((e) => e.kind === "agent_message" && /budget/i.test((e as any).content)));
  assert.equal(events.at(-1)!.kind, "done");
});

test("build records the session cost into the governor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const gov = new BudgetGovernor({ capUsd: 100 });
  const q = (() => async function* () {
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry(), governor: gov } as any);
  await fleet.build({ projectId: "pc", plan, onEvent: () => {} });
  assert.equal(gov.snapshot().spentUsd, 0.42);
});

test("build returns buildOk:true when the success sentinel is present", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const q = (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Built it. FLEET_BUILD_RESULT: ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() } as any);
  const res = await fleet.build({ projectId: "pok", plan, onEvent: () => {} });
  assert.equal(res.buildOk, true);
});

test("build returns buildOk:false on failed/absent sentinel", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const q = (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Could not finish. FLEET_BUILD_RESULT: failed" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() } as any);
  const res = await fleet.build({ projectId: "pfail", plan, onEvent: () => {} });
  assert.equal(res.buildOk, false);
});

test("build returns buildOk:false when offline (null query)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const fleet = new ClaudeFleet({ query: null, workspaceRoot: root, registry: new FleetSessionRegistry() } as any);
  const res = await fleet.build({ projectId: "poff", plan, onEvent: () => {} });
  assert.equal(res.buildOk, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeRemediator } from "./remediation";
import type { QueryFn } from "./sdk";
import { BudgetGovernor } from "./budget";

const deployment = { id: "dpl_1", status: "failed", createdAt: new Date(0).toISOString(), logs: ["npm ci", "next build", "Error: Module not found: './missing'"] };

function fakeQuery(cap: Record<string, any>, transcript: unknown[]): QueryFn {
  return (async function* ({ options }: { options: unknown }) {
    cap.options = options;
    for (const m of transcript) yield m as any;
  }) as unknown as QueryFn;
}
function asst(text: string) { return { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }; }
function toolUse(name: string) { return { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t" + Math.random(), name, input: { file_path: "x" } }] } }; }
function result() { return { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02 }; }

test("ok=true when a file changed and the success sentinel is present; passes safe options", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const cap: Record<string, any> = {};
  const transcript = [asst("Diagnosing the failed build."), toolUse("Edit"), asst("Fixed the import. REMEDIATION_RESULT: ok"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery(cap, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, true);
  assert.ok(out.filesChanged >= 1);
  assert.match(out.diagnosis, /Diagnosing|Fixed/);
  assert.equal(cap.options.permissionMode, "dontAsk");
  assert.equal(cap.options.cwd, path.resolve(root, "p1", "workspace"));
  assert.ok(Array.isArray(cap.options.disallowedTools) && cap.options.disallowedTools.length > 0);
  assert.ok(cap.options.maxBudgetUsd > 0 && cap.options.maxTurns >= 1);
});

test("ok=false when the failed sentinel is present", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const transcript = [asst("Tried, but build still fails. REMEDIATION_RESULT: failed"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery({}, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
});

test("ok=false when no sentinel is present (conservative)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const transcript = [asst("I changed a file."), toolUse("Write"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery({}, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
});

test("offline (null query) returns ok=false with an offline message", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const r = new ClaudeRemediator({ query: null, workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
  assert.match(out.detail, /offline|ANTHROPIC/i);
});

test("remediate is blocked (no query call) when over daily budget", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  let calls = 0;
  const gov = new BudgetGovernor({ capUsd: 1 });
  gov.record(1);
  const q = (() => { calls++; return (async function* () {})(); }) as any;
  const r = new ClaudeRemediator({ query: q, workspaceRoot: root, governor: gov } as any);
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
  assert.match(out.detail, /budget/i);
  assert.equal(calls, 0);
});

test("remediate records session cost", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const gov = new BudgetGovernor({ capUsd: 100 });
  const transcript = [{ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }, { type: "text", text: "REMEDIATION_RESULT: ok" }] } }, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.33 }];
  const q = (() => async function* () { for (const m of transcript) yield m; })();
  const r = new ClaudeRemediator({ query: q as any, workspaceRoot: root, governor: gov } as any);
  await r.remediate({ projectId: "p1", deployment });
  assert.equal(gov.snapshot().spentUsd, 0.33);
});

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

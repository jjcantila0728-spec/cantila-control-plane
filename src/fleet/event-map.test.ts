import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSdkMessage, type MapCtx } from "./event-map";

function ctx(): MapCtx { return { agentByToolUseId: new Map() }; }

test("assistant text -> agent_message", () => {
  const evs = mapSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Planning the build." }] } } as any, ctx());
  assert.equal(evs[0].kind, "agent_message");
  assert.match((evs[0] as any).content, /Planning/);
});

test("assistant tool_use -> op_started", () => {
  const evs = mapSdkMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tu1", name: "Write", input: { file_path: "src/page.tsx" } }] } } as any, ctx());
  const op = evs.find((e) => e.kind === "op_started") as any;
  assert.ok(op);
  assert.equal(op.opKey, "tool:tu1");
});

test("user tool_result -> op_finished ok with the agent that started it", () => {
  const c = ctx();
  c.agentByToolUseId.set("tu1", { agent: "react-engineer", title: "Write src/page.tsx" });
  const evs = mapSdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } } as any, c);
  const fin = evs.find((e) => e.kind === "op_finished") as any;
  assert.ok(fin);
  assert.equal(fin.status, "ok");
  assert.equal(fin.agent, "react-engineer");
});

test("tool_result with is_error -> op_finished failed", () => {
  const c = ctx();
  c.agentByToolUseId.set("tu2", { agent: "api-engineer", title: "Bash" });
  const evs = mapSdkMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true }] } } as any, c);
  const fin = evs.find((e) => e.kind === "op_finished") as any;
  assert.equal(fin.status, "failed");
});

test("result success -> result+done; error -> error+done", () => {
  const c = ctx();
  c.result = { name: "shop", url: "shop.cantila.app", stack: "Next.js" };
  const ok = mapSdkMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.1, result: "built" } as any, c);
  assert.ok(ok.some((e) => e.kind === "result"));
  assert.equal(ok.at(-1)!.kind, "done");
  const bad = mapSdkMessage({ type: "result", subtype: "error", is_error: true, total_cost_usd: 0.1 } as any, ctx());
  assert.ok(bad.some((e) => e.kind === "error"));
  assert.equal(bad.at(-1)!.kind, "done");
});

test("system/init and unknown messages map to nothing", () => {
  assert.deepEqual(mapSdkMessage({ type: "system", subtype: "init" } as any, ctx()), []);
});

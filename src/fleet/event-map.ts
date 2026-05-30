import type { OrchestratorEvent } from "../agents/project-orchestrator";

export interface MapCtx {
  /** tool_use_id -> the agent + title that started it (filled as ops start). */
  agentByToolUseId: Map<string, { agent: string; title: string }>;
  /** Build identity used in the final result event. */
  result?: { name: string; url: string; stack: string };
}

/** Pure mapping from one SDK message to zero+ OrchestratorEvents. Defensive about
 *  field shape — field names confirmed against
 *  node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts. */
export function mapSdkMessage(msg: any, ctx: MapCtx): OrchestratorEvent[] {
  const out: OrchestratorEvent[] = [];
  const agent = subagentId(msg) ?? "orchestrator";

  if (msg?.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        out.push({ kind: "agent_message", agent, content: block.text.trim() });
      } else if (block.type === "tool_use") {
        const title = `${agent} · ${block.name}`;
        const opKey = `tool:${block.id}`;
        ctx.agentByToolUseId.set(block.id, { agent, title });
        out.push({ kind: "op_started", opKey, agent, title });
      }
    }
  } else if (msg?.type === "user") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_result") {
        const started = ctx.agentByToolUseId.get(block.tool_use_id);
        const a = started?.agent ?? agent;
        const title = started?.title ?? `${a} · tool`;
        const detail = typeof block.content === "string" ? block.content.slice(0, 300) : "done";
        out.push({
          kind: "op_finished",
          opKey: `tool:${block.tool_use_id}`,
          agent: a,
          title,
          detail,
          status: block.is_error ? "failed" : "ok",
        });
      }
    }
  } else if (msg?.type === "result") {
    if (msg.is_error) {
      out.push({ kind: "error", error: msg.result ?? "build failed" });
    } else if (ctx.result) {
      out.push({ kind: "result", name: ctx.result.name, url: ctx.result.url, stack: ctx.result.stack });
    }
    out.push({ kind: "done" });
  }
  return out;
}

/** Best-effort subagent attribution. The SDK marks subagent output via
 *  agent_type / agent_id fields; default to orchestrator when absent. */
function subagentId(msg: any): string | null {
  return msg?.agent_type ?? msg?.agent_id ?? null;
}

import { mkdir } from "node:fs/promises";
import type { QueryFn } from "./sdk";
import type { DeployPlan } from "../ai/deploy-planner";
import type { OrchestratorEventHandler } from "../agents/project-orchestrator";
import { workspaceDir } from "./workspace";
import { agentDefinitions } from "./roster/agent-defs";
import { mapSdkMessage, type MapCtx } from "./event-map";
import { FleetSessionRegistry } from "./session-registry";
import { fleetConfig } from "./config";
import { ALLOWED_TOOLS, DISALLOWED_BASH } from "./tool-policy";
import { getBudgetGovernor, type BudgetGovernor } from "./budget";

export interface ClaudeFleetDeps {
  query: QueryFn | null;
  workspaceRoot: string;
  registry: FleetSessionRegistry;
  governor?: BudgetGovernor;
}

export class ClaudeFleet {
  private inFlight = 0;
  constructor(private deps: ClaudeFleetDeps) {}

  async build(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<{ buildOk: boolean }> {
    const prompt =
      `You are 00-orchestrator, driver + approval gate of Cantila's build fleet. Build a shippable MVP for this request, ` +
      `delegating to specialist subagents (use the Agent tool). Write real files into the working directory — no mock data. ` +
      `Request: "${input.plan.summary}". Project name: ${input.plan.name}. Stack: ${input.plan.stack}. ` +
      `Keep scope tight; stop when the core flow works. ` +
      `When finished, output a final line EXACTLY one of: FLEET_BUILD_RESULT: ok (you built it AND an in-session build/typecheck passes) or FLEET_BUILD_RESULT: failed (otherwise).`;
    return this.run(input.projectId, prompt, input.onEvent, {
      name: input.plan.name, url: `${input.plan.name}.cantila.app`, stack: input.plan.stack,
    });
  }

  async chat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler }): Promise<{ buildOk: boolean }> {
    return this.run(input.projectId, input.message, input.onEvent, {
      name: input.projectId, url: `${input.projectId}.cantila.app`, stack: "",
    });
  }

  private async run(projectId: string, prompt: string, onEvent: OrchestratorEventHandler, result: { name: string; url: string; stack: string }): Promise<{ buildOk: boolean }> {
    const cfg = fleetConfig();
    const governor = this.deps.governor ?? getBudgetGovernor();
    let doneSent = false;
    const emit: OrchestratorEventHandler = (e) => {
      if (e.kind === "done") {
        if (doneSent) return;
        doneSent = true;
      }
      onEvent(e);
    };
    if (!this.deps.query) {
      emit({ kind: "agent_message", agent: "orchestrator", content: "Fleet is offline — set ANTHROPIC_API_KEY and install the Claude Agent SDK to run a live build." });
      emit({ kind: "done" });
      return { buildOk: false };
    }
    if (!governor.canSpend()) {
      const s = governor.snapshot();
      emit({ kind: "agent_message", agent: "orchestrator", content: `Daily Claude budget reached ($${s.spentUsd}/$${s.capUsd}) — paused until UTC reset.` });
      emit({ kind: "done" });
      return { buildOk: false };
    }
    if (this.inFlight >= cfg.maxConcurrentBuilds) {
      emit({ kind: "agent_message", agent: "orchestrator", content: "Fleet is at capacity; queued. Try again shortly." });
      emit({ kind: "done" });
      return { buildOk: false };
    }
    this.inFlight++;
    this.deps.registry.startBuild(projectId);
    const cwd = workspaceDir(this.deps.workspaceRoot, projectId);
    await mkdir(cwd, { recursive: true });
    const ctx: MapCtx = { agentByToolUseId: new Map(), result };
    let texts = "";
    try {
      const stream = this.deps.query({
        prompt,
        options: {
          cwd,
          agents: agentDefinitions(),
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_BASH,
          permissionMode: "dontAsk",
          maxTurns: cfg.maxAgentSteps * cfg.maxRounds,
          maxBudgetUsd: cfg.maxBudgetUsd,
          model: "opus",
        } as any,
      });
      for await (const msg of stream) {
        if (msg && (msg as any).type === "result" && typeof (msg as any).total_cost_usd === "number") {
          governor.record((msg as any).total_cost_usd);
        }
        if (msg?.type === "assistant") { for (const b of (msg as any).message?.content ?? []) { if (b.type === "text" && b.text) texts += " " + b.text; } }
        for (const ev of mapSdkMessage(msg, ctx)) {
          if (ev.kind === "op_started") this.deps.registry.setAgentStatus(projectId, ev.agent, "working");
          if (ev.kind === "op_finished") this.deps.registry.setAgentStatus(projectId, ev.agent, ev.status === "ok" ? "done" : "failed");
          emit(ev);
        }
      }
    } catch (err) {
      emit({ kind: "error", error: err instanceof Error ? err.message : "fleet run failed" });
      // fall through to finally, then return buildOk:false below
    } finally {
      this.inFlight--;
      this.deps.registry.endBuild(projectId);
      emit({ kind: "done" });
    }
    const buildOk = /FLEET_BUILD_RESULT:\s*ok\b/i.test(texts) && !/FLEET_BUILD_RESULT:\s*failed\b/i.test(texts);
    return { buildOk };
  }
}

import { mkdir } from "node:fs/promises";
import type { QueryFn } from "./sdk";
import type { DeployPlan } from "../ai/deploy-planner";
import type { OrchestratorEventHandler } from "../agents/project-orchestrator";
import { workspaceDir } from "./workspace";
import { agentDefinitions } from "./roster/agent-defs";
import { mapSdkMessage, type MapCtx } from "./event-map";
import { FleetSessionRegistry } from "./session-registry";
import { fleetConfig } from "./config";

const DISALLOWED = [
  "Bash(rm:*)", "Bash(sudo:*)", "Bash(git push:*)", "Bash(curl:*)", "Bash(wget:*)",
];
const ALLOWED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];

export interface ClaudeFleetDeps {
  query: QueryFn | null;
  workspaceRoot: string;
  registry: FleetSessionRegistry;
}

export class ClaudeFleet {
  private inFlight = 0;
  constructor(private deps: ClaudeFleetDeps) {}

  async build(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<void> {
    const prompt =
      `You are 00-orchestrator, driver + approval gate of Cantila's build fleet. Build a shippable MVP for this request, ` +
      `delegating to specialist subagents (use the Agent tool). Write real files into the working directory — no mock data. ` +
      `Request: "${input.plan.summary}". Project name: ${input.plan.name}. Stack: ${input.plan.stack}. ` +
      `Keep scope tight; stop when the core flow works.`;
    await this.run(input.projectId, prompt, input.onEvent, {
      name: input.plan.name, url: `${input.plan.name}.cantila.app`, stack: input.plan.stack,
    });
  }

  async chat(input: { projectId: string; message: string; onEvent: OrchestratorEventHandler }): Promise<void> {
    await this.run(input.projectId, input.message, input.onEvent, {
      name: input.projectId, url: `${input.projectId}.cantila.app`, stack: "",
    });
  }

  private async run(projectId: string, prompt: string, onEvent: OrchestratorEventHandler, result: { name: string; url: string; stack: string }): Promise<void> {
    const cfg = fleetConfig();
    if (!this.deps.query) {
      onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is offline — set ANTHROPIC_API_KEY and install the Claude Agent SDK to run a live build." });
      onEvent({ kind: "done" });
      return;
    }
    if (this.inFlight >= cfg.maxConcurrentBuilds) {
      onEvent({ kind: "agent_message", agent: "orchestrator", content: "Fleet is at capacity; queued. Try again shortly." });
      onEvent({ kind: "done" });
      return;
    }
    this.inFlight++;
    this.deps.registry.startBuild(projectId);
    const cwd = workspaceDir(this.deps.workspaceRoot, projectId);
    await mkdir(cwd, { recursive: true });
    const ctx: MapCtx = { agentByToolUseId: new Map(), result };
    try {
      const stream = this.deps.query({
        prompt,
        options: {
          cwd,
          agents: agentDefinitions(),
          allowedTools: ALLOWED,
          disallowedTools: DISALLOWED,
          permissionMode: "dontAsk",
          maxTurns: cfg.maxAgentSteps * cfg.maxRounds,
          maxBudgetUsd: cfg.maxBudgetUsd,
          model: "opus",
        } as any,
      });
      for await (const msg of stream) {
        for (const ev of mapSdkMessage(msg, ctx)) {
          if (ev.kind === "op_started") this.deps.registry.setAgentStatus(projectId, ev.agent, "working");
          if (ev.kind === "op_finished") this.deps.registry.setAgentStatus(projectId, ev.agent, ev.status === "ok" ? "done" : "failed");
          onEvent(ev);
        }
      }
    } catch (err) {
      onEvent({ kind: "error", error: err instanceof Error ? err.message : "fleet run failed" });
      onEvent({ kind: "done" });
    } finally {
      this.inFlight--;
      this.deps.registry.endBuild(projectId);
    }
  }
}

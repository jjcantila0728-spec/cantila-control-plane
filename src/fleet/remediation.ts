import { mkdir } from "node:fs/promises";
import type { QueryFn } from "./sdk";
import { workspaceDir } from "./workspace";
import { agentDefinitions } from "./roster/agent-defs";
import { fleetConfig } from "./config";
import type { OrchestratorEvent } from "../agents/project-orchestrator";

const DISALLOWED = [
  "Bash(rm:*)", "Bash(sudo:*)", "Bash(mv:*)", "Bash(chmod:*)",
  "Bash(git push:*)", "Bash(git clone:*)", "Bash(git reset:*)",
  "Bash(curl:*)", "Bash(wget:*)",
];
const ALLOWED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];

export interface DeploymentLike {
  id: string;
  status: string;
  createdAt: string;
  logs: string[];
}

export interface RemediationResult {
  ok: boolean;
  detail: string;
  filesChanged: number;
  diagnosis: string;
}

export interface ClaudeRemediatorDeps {
  query: QueryFn | null;
  workspaceRoot: string;
  onEvent?: (e: OrchestratorEvent) => void;
}

export class ClaudeRemediator {
  constructor(private deps: ClaudeRemediatorDeps) {}

  async remediate(input: { projectId: string; deployment: DeploymentLike }): Promise<RemediationResult> {
    if (!this.deps.query) {
      return { ok: false, detail: "remediation offline — ANTHROPIC_API_KEY not set", filesChanged: 0, diagnosis: "" };
    }
    const cfg = fleetConfig();
    const cwd = workspaceDir(this.deps.workspaceRoot, input.projectId);
    await mkdir(cwd, { recursive: true });

    const logs = (input.deployment.logs ?? []).slice(-40).join("\n");
    const prompt =
      `A deployment of this project FAILED. You are 00-orchestrator of Cantila's build fleet. ` +
      `Diagnose the root cause from the build logs below and FIX it in the working directory — real edits, no mock data. ` +
      `Delegate to devops-engineer, the relevant builder (e.g. react-engineer/api-engineer), and qa-engineer via the Agent tool. ` +
      `After fixing, run the project's build or typecheck to confirm it compiles. Do NOT deploy or touch production.\n\n` +
      `--- deployment ${input.deployment.id} logs (tail) ---\n${logs || "(no logs)"}\n--- end logs ---\n\n` +
      `When finished, output a final line EXACTLY one of:\n` +
      `REMEDIATION_RESULT: ok   (you applied a fix AND the build/typecheck passes)\n` +
      `REMEDIATION_RESULT: failed   (otherwise)`;

    let texts = "";
    let filesChanged = 0;
    let errored = false;
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
      for await (const msg of stream as any) {
        if (msg?.type === "assistant") {
          for (const b of msg.message?.content ?? []) {
            if (b.type === "text" && b.text) texts += " " + b.text;
            if (b.type === "tool_use" && (b.name === "Write" || b.name === "Edit")) filesChanged++;
          }
          this.deps.onEvent?.({ kind: "agent_message", agent: "remediation", content: "(remediating)" });
        } else if (msg?.type === "result" && msg.is_error) {
          errored = true;
        }
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "remediation session failed", filesChanged, diagnosis: texts.trim().slice(0, 1000) };
    }

    const sentinelOk = /REMEDIATION_RESULT:\s*ok\b/i.test(texts);
    const sentinelFail = /REMEDIATION_RESULT:\s*failed\b/i.test(texts);
    const ok = sentinelOk && !sentinelFail && !errored && filesChanged >= 1;
    const detail = ok
      ? `prepared a fix (${filesChanged} file change(s)); build/typecheck passed in-session`
      : sentinelFail
      ? `could not produce a passing fix (${filesChanged} file change(s))`
      : `no confirmed fix (${filesChanged} file change(s), no success sentinel)`;
    return { ok, detail, filesChanged, diagnosis: texts.trim().slice(0, 1000) };
  }
}

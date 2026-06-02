import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { SdkToolName } from "../types";
import { SDK_TOOL_NAMES } from "../types";
import { listRoles } from "./index";

const TOOL_ALIAS: Record<string, SdkToolName> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Glob",
  grep: "Grep", bash: "Bash", task: "Agent", agent: "Agent",
};

/** Map AgentFleet `tools:` strings to SDK tool names; unknown tools dropped. */
export function toSdkTools(tools: string[]): SdkToolName[] {
  const out = new Set<SdkToolName>();
  for (const t of tools) {
    const mapped = TOOL_ALIAS[t.trim().toLowerCase()];
    if (mapped && SDK_TOOL_NAMES.includes(mapped)) out.add(mapped);
  }
  return [...out];
}

const SECURITY_DIVISIONS = new Set(["security"]);

/** All build agents as SDK subagent definitions, keyed by id.
 *  The orchestrator (00-orchestrator) is the session's MAIN agent, not a subagent.
 *  When `modelOverride` is set (FLEET_SUBAGENT_MODEL), every subagent runs on
 *  that model instead of its per-role default — the lever to drop the ~21
 *  Opus roles down to Sonnet for cheaper chat builds. */
export function agentDefinitions(modelOverride?: string): Record<string, AgentDefinition> {
  const defs: Record<string, AgentDefinition> = {};
  for (const r of listRoles()) {
    if (r.id === "00-orchestrator") continue;
    const prompt = SECURITY_DIVISIONS.has(r.division)
      ? `${r.systemPrompt}\n\nIMPORTANT: authorized/defensive security work only.`
      : r.systemPrompt;
    defs[r.id] = {
      description: r.description,
      prompt,
      tools: toSdkTools(r.tools),
      model: modelOverride ?? r.model,
    } as AgentDefinition;
  }
  return defs;
}

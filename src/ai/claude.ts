/* ============================================================
   ClaudeAiAnalyser — the real LLM-backed adapter (plan §5.6).

   Implements `AiAnalyser` via the official Anthropic SDK against the
   endpoint resolved by `ai/llm.ts` — the platform default (config.llm,
   which may be a cheaper Anthropic-compatible provider like MiniMax M3)
   or a tenant's bring-your-own Anthropic key. Pattern matches
   `StubStripeAdapter` / `RuleBasedAiAnalyser` — same interface, swap-in
   at the `ControlPlane` deps boundary, no other call sites move.

   Design notes:
   - **Tool-use for structured output.** Each method declares one
     tool the model is forced to call (`tool_choice: {type:"tool",
     name}`); the tool's `input_schema` is the contract. Parsing
     is `JSON.parse`-safe — Sonnet 4.6 escapes inputs consistently.
   - **Prompt caching.** Both methods share a stable system prompt
     marked `cache_control: {type:"ephemeral"}`. The volatile
     per-call facts go in the user turn, after the breakpoint, so
     the cached prefix is reused on every analysis.
   - **Fallback.** Any error (missing API key, rate limit, schema
     mismatch, model refusal) falls through to the rule-based
     analyser. The brain's user-visible behaviour degrades to
     "rule-based" rather than "broken" if Claude is unavailable.
   ============================================================ */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AiAnalyser,
  AnalyseCostInput,
  AnalyseDeployInput,
} from "./analyser";
import type {
  CostRecommendation,
  TroubleshootSuggestion,
} from "../core/control-plane";
import { resolveLlmEndpoint, llmSystem, type LlmEndpoint } from "./llm";

const MAX_TOKENS = 4_000;

export const SYSTEM_PROMPT = `You are Cantila's AI ops analyser. Cantila is a managed VPS-powered hosting cloud — every project gets an auto-wired managed Postgres, a sending mailbox, and an SMS number; deploys go through an 8-step pipeline (source-received → stack-detected → services-provisioned → image-built → scheduled → container-started → routed → verified).

Your job is to read structured facts about a deployment or an account's resources and emit concise, actionable suggestions through the provided tool. Keep titles under 80 chars and bodies under 400 chars. Use confidence levels honestly: "high" only when the cause is unambiguous from the facts; "medium" when the most likely cause has a known alternative; "low" for plausible-but-uncertain hints. Concrete remediation commands belong in the actions array (label + cli hint), not the prose body.

Never invent project ids, deployment ids, or commands the operator cannot run. Never refuse — if the facts are insufficient, emit a single low-confidence suggestion that says so and proposes an investigation step.`;

export const DEPLOY_TOOL: Anthropic.Tool = {
  name: "propose_troubleshoot_suggestions",
  description:
    "Emit the ordered list of troubleshooting suggestions for one deployment. Newest-most-relevant first.",
  input_schema: {
    type: "object",
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            title: { type: "string" },
            body: { type: "string" },
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  hint: { type: "string" },
                },
                required: ["label", "hint"],
              },
            },
          },
          required: ["confidence", "title", "body"],
        },
      },
    },
    required: ["suggestions"],
  },
};

export const COST_TOOL: Anthropic.Tool = {
  name: "propose_cost_recommendations",
  description:
    "Emit the list of cost-optimisation recommendations for one account.",
  input_schema: {
    type: "object",
    properties: {
      recommendations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: {
              type: "string",
              enum: [
                "idle_alwayson",
                "oversized_ram",
                "oversized_cpu",
                "oversized_disk",
                "stale_project",
                "unused_bucket",
                "unused_domain",
              ],
            },
            projectId: { type: "string" },
            projectName: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            title: { type: "string" },
            body: { type: "string" },
            savingsCentsPerMonth: { type: "integer" },
            actions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  hint: { type: "string" },
                },
                required: ["label", "hint"],
              },
            },
          },
          required: [
            "id",
            "kind",
            "confidence",
            "title",
            "body",
            "savingsCentsPerMonth",
          ],
        },
      },
    },
    required: ["recommendations"],
  },
};

export interface ClaudeAiAnalyserOpts {
  /** Bring-your-own Anthropic key (tenant flow, plan §4.3.1). When set,
   *  the call always targets real Anthropic. When omitted, the platform
   *  default endpoint (config.llm) is used — which may be a cheaper
   *  Anthropic-compatible provider such as MiniMax M3. */
  apiKey?: string;
  /** Fallback used on any error or when no LLM is configured. */
  fallback: AiAnalyser;
}

export class ClaudeAiAnalyser implements AiAnalyser {
  readonly label: string;
  readonly live: boolean;
  private endpoint: LlmEndpoint | null;
  private fallback: AiAnalyser;

  constructor(opts: ClaudeAiAnalyserOpts) {
    this.fallback = opts.fallback;
    this.endpoint = resolveLlmEndpoint(opts.apiKey);
    if (!this.endpoint) {
      this.label = "LLM (not configured — using rule-based fallback)";
      this.live = false;
      return;
    }
    this.label = `LLM (${this.endpoint.label})`;
    this.live = true;
  }

  async analyseDeploy(
    input: AnalyseDeployInput,
  ): Promise<TroubleshootSuggestion[]> {
    if (!this.endpoint) return this.fallback.analyseDeploy(input);
    try {
      const result = await this.callTool<{
        suggestions: TroubleshootSuggestion[];
      }>(DEPLOY_TOOL, deployFacts(input));
      return result.suggestions ?? [];
    } catch {
      return this.fallback.analyseDeploy(input);
    }
  }

  async analyseCost(input: AnalyseCostInput): Promise<CostRecommendation[]> {
    if (!this.endpoint) return this.fallback.analyseCost(input);
    try {
      const result = await this.callTool<{
        recommendations: CostRecommendation[];
      }>(COST_TOOL, costFacts(input));
      return result.recommendations ?? [];
    } catch {
      return this.fallback.analyseCost(input);
    }
  }

  /** Single Claude call with forced tool use + cached system prompt.
   *  Throws on any error; the public methods translate that to the
   *  fallback path. */
  private async callTool<T>(tool: Anthropic.Tool, factsJson: string): Promise<T> {
    if (!this.endpoint) throw new Error("no llm endpoint");
    const response = await this.endpoint.client.messages.create({
      model: this.endpoint.model,
      max_tokens: MAX_TOKENS,
      // Stable across every call — on real Anthropic the cache_control
      // breakpoint reuses the prefix and keeps per-tick spend bounded;
      // compatible endpoints omit it (see llmSystem).
      system: llmSystem(SYSTEM_PROMPT, this.endpoint.cache),
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [
        {
          role: "user",
          content: `Analyse these facts and call ${tool.name} with the result.\n\n${factsJson}`,
        },
      ],
    });
    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) throw new Error("model did not call the structured tool");
    return toolUse.input as T;
  }
}

/** Serialise a deployment into the stable JSON fact-sheet both the Claude
 *  and OpenAI analysers feed to the model. Exported so the OpenAI adapter
 *  (ai/openai.ts) reuses the exact same contract. */
export function deployFacts(input: AnalyseDeployInput): string {
  return JSON.stringify(
    {
      project: {
        id: input.project.id,
        name: input.project.name,
        runtime: input.project.runtime,
        region: input.project.region,
        status: input.project.status,
      },
      deployment: {
        id: input.deployment.id,
        status: input.deployment.status,
        trigger: input.deployment.trigger,
        lastStep:
          input.deployment.logs[input.deployment.logs.length - 1] ?? null,
        logs: input.deployment.logs,
      },
      rollbackTarget:
        input.allDeployments
          .filter((d) => d.id !== input.deployment.id && d.status === "live")
          .pop()?.id ?? null,
    },
    null,
    2,
  );
}

/** Serialise an account's resources into the stable cost fact-sheet. */
export function costFacts(input: AnalyseCostInput): string {
  return JSON.stringify(
    {
      accountId: input.accountId,
      projects: input.projects.map((p) => ({
        id: p.id,
        name: p.name,
        runtime: p.runtime,
        status: p.status,
        vcpu: p.vcpu,
        memoryMb: p.memoryMb,
        diskGb: p.diskGb,
        alwaysOn: p.alwaysOn,
        createdAt: p.createdAt,
      })),
      deploymentCountsPerProject: countBy(
        input.allDeployments,
        (d) => d.projectId,
      ),
      buckets: input.buckets.map((b) => ({
        id: b.id,
        projectId: b.projectId,
        name: b.name,
        objects: b.objects,
        sizeGb: b.sizeGb,
      })),
      registrations: input.registrations.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        attachedProjectId: r.attachedProjectId ?? null,
        pricePerYearCents: r.pricePerYearCents,
        expiresAt: r.expiresAt,
      })),
    },
    null,
    2,
  );
}

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

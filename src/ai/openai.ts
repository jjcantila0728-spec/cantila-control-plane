/* ============================================================
   OpenAI-backed product adapters (plan §5.6 / Option B).

   `OpenAiAiAnalyser` and `OpenAiDeployPlanner` implement the same
   `AiAnalyser` / `DeployPlanner` ports as the Claude adapters, so the
   factory (ai/factory.ts) can swap them in when LLM_PROVIDER=openai —
   no other call site moves.

   They reuse the exact prompts, JSON schemas, fact-sheets and plan
   normaliser from the Claude adapters (the JSON `input_schema` doubles
   as an OpenAI function `parameters` schema), and force a single
   function call (`tool_choice: {type:"function"}`) so the structured
   output is the function's arguments — the same contract as the
   Anthropic forced-tool path. Any error degrades to the rule-based
   fallback, identical posture to the Claude adapters.

   Implemented with `fetch` (no SDK dependency) — matches the
   `ReplicateImageProvider` pattern already in the codebase. Prompt
   caching is automatic on OpenAI, so no cache-control plumbing is
   needed here.
   ============================================================ */

import type {
  AiAnalyser,
  AnalyseCostInput,
  AnalyseDeployInput,
} from "./analyser";
import type {
  CostRecommendation,
  TroubleshootSuggestion,
} from "../core/control-plane";
import {
  SYSTEM_PROMPT as ANALYSER_SYSTEM_PROMPT,
  DEPLOY_TOOL,
  COST_TOOL,
  deployFacts,
  costFacts,
} from "./claude";
import {
  SYSTEM_PROMPT as PLANNER_SYSTEM_PROMPT,
  PLAN_TOOL,
  normalisePlan,
  type DeployPlan,
  type DeployPlanner,
  type DeployPlannerInput,
} from "./deploy-planner";
import { defaultOpenAiConfig, type OpenAiConfig } from "./llm";

const ANALYSER_MAX_TOKENS = 4_000;
const PLANNER_MAX_TOKENS = 1_500;

/** OpenAI chat function spec — built from an Anthropic tool's schema. */
interface OpenAiFunction {
  name: string;
  description?: string;
  parameters: unknown;
}

function toFunction(tool: {
  name: string;
  description?: string;
  input_schema: unknown;
}): OpenAiFunction {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  };
}

/** One OpenAI chat-completions call with a forced single function call.
 *  Returns the parsed function arguments. Throws on any HTTP / shape /
 *  parse error so callers can fall through to the rule-based path. */
async function callOpenAiFunction<T>(
  cfg: OpenAiConfig,
  opts: { system: string; user: string; fn: OpenAiFunction; maxTokens: number },
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_completion_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      tools: [{ type: "function", function: opts.fn }],
      tool_choice: { type: "function", function: { name: opts.fn.name } },
    }),
  });
  if (!resp.ok) {
    throw new Error(`openai ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    choices?: {
      message?: { tool_calls?: { function?: { arguments?: string } }[] };
    }[];
  };
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) throw new Error("openai: model did not return a function call");
  return JSON.parse(args) as T;
}

/* ---------- analyser ---------- */

export interface OpenAiAiAnalyserOpts {
  /** Fallback used on any error or when OpenAI is not configured. */
  fallback: AiAnalyser;
}

export class OpenAiAiAnalyser implements AiAnalyser {
  readonly label: string;
  readonly live: boolean;
  private cfg: OpenAiConfig | null;
  private fallback: AiAnalyser;

  constructor(opts: OpenAiAiAnalyserOpts) {
    this.fallback = opts.fallback;
    this.cfg = defaultOpenAiConfig();
    if (!this.cfg) {
      this.label = "OpenAI (not configured — using rule-based fallback)";
      this.live = false;
      return;
    }
    this.label = `OpenAI (${this.cfg.model})`;
    this.live = true;
  }

  async analyseDeploy(
    input: AnalyseDeployInput,
  ): Promise<TroubleshootSuggestion[]> {
    if (!this.cfg) return this.fallback.analyseDeploy(input);
    try {
      const result = await callOpenAiFunction<{
        suggestions: TroubleshootSuggestion[];
      }>(this.cfg, {
        system: ANALYSER_SYSTEM_PROMPT,
        user: `Analyse these facts and call ${DEPLOY_TOOL.name} with the result.\n\n${deployFacts(input)}`,
        fn: toFunction(DEPLOY_TOOL),
        maxTokens: ANALYSER_MAX_TOKENS,
      });
      return result.suggestions ?? [];
    } catch {
      return this.fallback.analyseDeploy(input);
    }
  }

  async analyseCost(input: AnalyseCostInput): Promise<CostRecommendation[]> {
    if (!this.cfg) return this.fallback.analyseCost(input);
    try {
      const result = await callOpenAiFunction<{
        recommendations: CostRecommendation[];
      }>(this.cfg, {
        system: ANALYSER_SYSTEM_PROMPT,
        user: `Analyse these facts and call ${COST_TOOL.name} with the result.\n\n${costFacts(input)}`,
        fn: toFunction(COST_TOOL),
        maxTokens: ANALYSER_MAX_TOKENS,
      });
      return result.recommendations ?? [];
    } catch {
      return this.fallback.analyseCost(input);
    }
  }
}

/* ---------- deploy planner ---------- */

export interface OpenAiDeployPlannerOpts {
  fallback: DeployPlanner;
}

export class OpenAiDeployPlanner implements DeployPlanner {
  private cfg: OpenAiConfig | null;
  private fallback: DeployPlanner;

  constructor(opts: OpenAiDeployPlannerOpts) {
    this.cfg = defaultOpenAiConfig();
    this.fallback = opts.fallback;
  }

  async plan(input: DeployPlannerInput): Promise<DeployPlan> {
    if (!this.cfg) return this.fallback.plan(input);
    try {
      const userTurn =
        `Prompt: ${input.prompt}\n` +
        (input.files && input.files.length > 0
          ? `Attached files: ${input.files.join(", ")}\n`
          : "");
      const parsed = await callOpenAiFunction<DeployPlan>(this.cfg, {
        system: PLANNER_SYSTEM_PROMPT,
        user: userTurn,
        fn: toFunction(PLAN_TOOL),
        maxTokens: PLANNER_MAX_TOKENS,
      });
      return normalisePlan(parsed);
    } catch {
      return this.fallback.plan(input);
    }
  }
}

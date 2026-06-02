/* ============================================================
   Product LLM factories (plan §5.6).

   Single place that picks the live analyser / deploy-planner for the
   configured provider (config.llm.provider), falling back to the
   deterministic rule-based adapters when no key is set. Kept separate
   from the adapters themselves so `ai/openai.ts` can import the Claude
   schemas without an import cycle.

   Scope: the platform-default product LLM only. A tenant's
   bring-your-own Anthropic key is resolved in `ControlPlane.analyserFor`
   and always uses the Claude adapter.
   ============================================================ */

import type { AiAnalyser } from "./analyser";
import { ClaudeAiAnalyser } from "./claude";
import { OpenAiAiAnalyser, OpenAiDeployPlanner } from "./openai";
import {
  RuleBasedDeployPlanner,
  ClaudeDeployPlanner,
  type DeployPlanner,
} from "./deploy-planner";
import { activeProvider, defaultLlmEndpoint, defaultOpenAiConfig } from "./llm";

/** Live analyser for the configured provider, or the supplied rule-based
 *  fallback when that provider has no key configured. */
export function buildAiAnalyser(fallback: AiAnalyser): AiAnalyser {
  if (activeProvider() === "openai") {
    return defaultOpenAiConfig() ? new OpenAiAiAnalyser({ fallback }) : fallback;
  }
  return defaultLlmEndpoint() ? new ClaudeAiAnalyser({ fallback }) : fallback;
}

/** Live deploy-planner for the configured provider, rule-based otherwise. */
export function buildDeployPlanner(): DeployPlanner {
  const ruleBased = new RuleBasedDeployPlanner();
  if (activeProvider() === "openai") {
    return defaultOpenAiConfig()
      ? new OpenAiDeployPlanner({ fallback: ruleBased })
      : ruleBased;
  }
  return defaultLlmEndpoint()
    ? new ClaudeDeployPlanner({ fallback: ruleBased })
    : ruleBased;
}

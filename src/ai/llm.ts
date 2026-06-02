/* ============================================================
   LLM endpoint / provider resolution (plan §5.6).

   Centralises how the product-layer LLM adapters get their client,
   model id, and provider so the backing model can be swapped via
   `config.llm` (LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL / LLM_API_KEY)
   without editing the adapters or their call sites.

   Two providers:
   - "anthropic" (default) — the Claude adapters, via the Anthropic SDK.
     `defaultLlmEndpoint()` builds the platform endpoint; when
     LLM_BASE_URL points at an Anthropic-compatible endpoint the SDK is
     retargeted and prompt-caching is disabled (compatible endpoints may
     reject `cache_control`).
   - "openai" — the OpenAI adapters (ai/openai.ts), via the REST API.
     `defaultOpenAiConfig()` resolves key/model/base-url.

   Bring-your-own: `anthropicEndpoint(key)` is a tenant's own Anthropic
   account (plan §4.3.1) — ALWAYS real Anthropic + canonical model +
   caching, never the platform overrides, since a tenant Claude key
   would not authenticate elsewhere.
   ============================================================ */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

export type LlmProvider = "anthropic" | "openai";

/** Canonical Anthropic model for bring-your-own-key tenant flows. */
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

/** Per-provider default model when LLM_MODEL is unset. */
const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
};

/** The configured product provider. */
export function activeProvider(): LlmProvider {
  return config.llm.provider === "openai" ? "openai" : "anthropic";
}

/* ---------- Anthropic endpoint (Claude adapters) ---------- */

export interface LlmEndpoint {
  client: Anthropic;
  /** Model id passed to `messages.create`. */
  model: string;
  /** Whether to emit `cache_control: {type:"ephemeral"}` breakpoints.
   *  Only real Anthropic supports them; compatible endpoints may 400. */
  cache: boolean;
  /** Operator-facing label, e.g. "claude-sonnet-4-6" or
   *  "claude-sonnet-4-6 (custom endpoint)". */
  label: string;
}

/** Platform-default Anthropic endpoint from `config.llm`. Returns null
 *  when no Anthropic key is configured — callers degrade to rule-based. */
export function defaultLlmEndpoint(): LlmEndpoint | null {
  const apiKey = config.llm.apiKey || config.llm.anthropicApiKey;
  if (!apiKey) return null;
  const model = config.llm.model || DEFAULT_MODEL.anthropic;
  const custom = config.llm.baseUrl !== "";
  return {
    client: new Anthropic({
      apiKey,
      ...(custom ? { baseURL: config.llm.baseUrl } : {}),
    }),
    model,
    cache: !custom,
    label: custom ? `${model} (custom endpoint)` : model,
  };
}

/** Bring-your-own Anthropic endpoint for a tenant key (plan §4.3.1). */
export function anthropicEndpoint(apiKey: string): LlmEndpoint {
  return {
    client: new Anthropic({ apiKey }),
    model: ANTHROPIC_MODEL,
    cache: true,
    label: ANTHROPIC_MODEL,
  };
}

/** Resolve an Anthropic endpoint from an optional explicit key: an explicit
 *  key is bring-your-own Anthropic; absence uses the platform default. */
export function resolveLlmEndpoint(apiKey?: string): LlmEndpoint | null {
  return apiKey ? anthropicEndpoint(apiKey) : defaultLlmEndpoint();
}

/** System-prompt blocks, with the ephemeral cache breakpoint applied only
 *  when the endpoint supports prompt caching. */
export function llmSystem(text: string, cache: boolean): Anthropic.TextBlockParam[] {
  return [
    cache
      ? { type: "text", text, cache_control: { type: "ephemeral" } }
      : { type: "text", text },
  ];
}

/* ---------- OpenAI config (OpenAI adapters) ---------- */

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  /** REST base, e.g. https://api.openai.com/v1. */
  baseUrl: string;
}

/** Platform-default OpenAI config from `config.llm`. Returns null when no
 *  OpenAI key is configured — callers degrade to rule-based. */
export function defaultOpenAiConfig(): OpenAiConfig | null {
  const apiKey = config.llm.apiKey || config.llm.openaiApiKey;
  if (!apiKey) return null;
  return {
    apiKey,
    model: config.llm.model || DEFAULT_MODEL.openai,
    baseUrl: config.llm.baseUrl || "https://api.openai.com/v1",
  };
}

/** True when the active provider has a usable key configured. Used at the
 *  product wiring points to pick the live adapter over the rule-based stub. */
export function llmConfigured(): boolean {
  return activeProvider() === "openai"
    ? defaultOpenAiConfig() !== null
    : defaultLlmEndpoint() !== null;
}

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

/** Required first system block when authenticating with a claude.ai
 *  subscription OAuth token. The OAuth inference path only accepts requests
 *  whose system prompt is led by the Claude Code identity; real instructions
 *  follow in subsequent blocks. (Verified against api.anthropic.com.) */
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

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
  /** True when authenticated with a claude.ai subscription OAuth token
   *  (Bearer) rather than an API key. OAuth requests must lead their system
   *  prompt with the Claude Code identity — see `llmSystem`. */
  oauth: boolean;
  /** Operator-facing label, e.g. "claude-sonnet-4-6" or
   *  "claude-sonnet-4-6 (custom endpoint)". */
  label: string;
}

/* ---------- Credential precedence (pure, unit-tested) ---------- */

export interface AnthropicAuthInput {
  /** Explicit LLM_API_KEY override (always an API key). */
  apiKeyOverride: string;
  /** ANTHROPIC_API_KEY. */
  anthropicApiKey: string;
  /** Subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN). */
  oauthToken: string;
  /** LLM_BASE_URL — when non-empty, a custom/compatible endpoint is in play. */
  baseUrl: string;
  /** LLM_MODEL — empty means the per-provider default. */
  model: string;
}

export type AnthropicAuthPlan =
  | { mode: "oauth"; token: string; model: string; cache: true; label: string }
  | {
      mode: "api-key";
      apiKey: string;
      model: string;
      baseUrl: string;
      cache: boolean;
      label: string;
    }
  | { mode: "none" };

/** Decide which Anthropic credential the platform analysers use.
 *
 *  Precedence:
 *  1. A custom `baseUrl` forces API-key auth — OAuth tokens only authenticate
 *     against api.anthropic.com, and compatible endpoints may reject caching.
 *  2. Otherwise a subscription OAuth token wins (so product LLM usage rides the
 *     subscription instead of metered API billing).
 *  3. Otherwise an API key (LLM_API_KEY override, else ANTHROPIC_API_KEY).
 *  4. Otherwise nothing — the caller degrades to the rule-based stub. */
export function planAnthropicAuth(input: AnthropicAuthInput): AnthropicAuthPlan {
  const model = input.model || DEFAULT_MODEL.anthropic;
  const apiKey = input.apiKeyOverride || input.anthropicApiKey;

  if (input.baseUrl !== "") {
    if (!apiKey) return { mode: "none" };
    return {
      mode: "api-key",
      apiKey,
      model,
      baseUrl: input.baseUrl,
      cache: false,
      label: `${model} (custom endpoint)`,
    };
  }

  if (input.oauthToken) {
    return {
      mode: "oauth",
      token: input.oauthToken,
      model,
      cache: true,
      label: `${model} (claude.ai subscription)`,
    };
  }

  if (apiKey) {
    return { mode: "api-key", apiKey, model, baseUrl: "", cache: true, label: model };
  }

  return { mode: "none" };
}

/** Platform-default Anthropic endpoint from `config.llm`. Returns null
 *  when no credential is configured — callers degrade to rule-based. */
export function defaultLlmEndpoint(): LlmEndpoint | null {
  const plan = planAnthropicAuth({
    apiKeyOverride: config.llm.apiKey,
    anthropicApiKey: config.llm.anthropicApiKey,
    oauthToken: config.llm.oauthToken,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
  });

  if (plan.mode === "none") return null;

  if (plan.mode === "oauth") {
    return {
      // `apiKey: null` suppresses the x-api-key header so only the Bearer
      // token is sent — the OAuth inference path rejects requests carrying both.
      client: new Anthropic({ authToken: plan.token, apiKey: null }),
      model: plan.model,
      cache: plan.cache,
      oauth: true,
      label: plan.label,
    };
  }

  return {
    client: new Anthropic({
      apiKey: plan.apiKey,
      ...(plan.baseUrl ? { baseURL: plan.baseUrl } : {}),
    }),
    model: plan.model,
    cache: plan.cache,
    oauth: false,
    label: plan.label,
  };
}

/** Bring-your-own Anthropic endpoint for a tenant key (plan §4.3.1). */
export function anthropicEndpoint(apiKey: string): LlmEndpoint {
  return {
    client: new Anthropic({ apiKey }),
    model: ANTHROPIC_MODEL,
    cache: true,
    oauth: false,
    label: ANTHROPIC_MODEL,
  };
}

/** Resolve an Anthropic endpoint from an optional explicit key: an explicit
 *  key is bring-your-own Anthropic; absence uses the platform default. */
export function resolveLlmEndpoint(apiKey?: string): LlmEndpoint | null {
  return apiKey ? anthropicEndpoint(apiKey) : defaultLlmEndpoint();
}

/** System-prompt blocks for a `messages.create` call.
 *
 *  - The ephemeral cache breakpoint is applied (on the instructions block) only
 *    when the endpoint supports prompt caching.
 *  - Under OAuth (`oauth: true`) the Claude Code identity is prepended as the
 *    first block, because the subscription inference path only accepts a system
 *    prompt led by that identity. The cache breakpoint stays on the instructions
 *    block, so the whole prefix (identity + instructions) is cached as one. */
export function llmSystem(
  text: string,
  cache: boolean,
  oauth = false,
): Anthropic.TextBlockParam[] {
  const instructions: Anthropic.TextBlockParam = cache
    ? { type: "text", text, cache_control: { type: "ephemeral" } }
    : { type: "text", text };
  return oauth
    ? [{ type: "text", text: CLAUDE_CODE_IDENTITY }, instructions]
    : [instructions];
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

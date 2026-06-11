/* OAuth-subscription analyser path (§BYO-subscription, product layer).
   Verifies that the product-layer Claude analysers can authenticate with a
   claude.ai subscription token (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN)
   instead of an Anthropic API key, including the Claude Code system identity
   prefix that the OAuth inference path mandates. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLAUDE_CODE_IDENTITY,
  llmSystem,
  planAnthropicAuth,
  type AnthropicAuthInput,
} from "./llm";

const EMPTY: AnthropicAuthInput = {
  apiKeyOverride: "",
  anthropicApiKey: "",
  oauthToken: "",
  baseUrl: "",
  model: "",
};

/* ---------- llmSystem: Claude Code identity prefix under OAuth ---------- */

test("llmSystem (api-key mode) is a single block, cached when asked", () => {
  const blocks = llmSystem("INSTRUCTIONS", true, false);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "INSTRUCTIONS");
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
});

test("llmSystem (oauth mode) prepends the Claude Code identity as the first block", () => {
  const blocks = llmSystem("INSTRUCTIONS", true, true);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, CLAUDE_CODE_IDENTITY);
  // Identity block carries no breakpoint; the cache breakpoint sits on the
  // real instructions so the whole prefix (identity + instructions) is cached.
  assert.equal(blocks[0].cache_control, undefined);
  assert.equal(blocks[1].text, "INSTRUCTIONS");
  assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
});

test("llmSystem (oauth mode, cache off) still prepends identity, no breakpoints", () => {
  const blocks = llmSystem("INSTRUCTIONS", false, true);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, CLAUDE_CODE_IDENTITY);
  assert.equal(blocks[1].text, "INSTRUCTIONS");
  assert.equal(blocks[1].cache_control, undefined);
});

/* ---------- planAnthropicAuth: credential precedence ---------- */

test("prefers the subscription OAuth token over the API key", () => {
  const plan = planAnthropicAuth({
    ...EMPTY,
    oauthToken: "sk-ant-oat01-test",
    anthropicApiKey: "sk-ant-api03-test",
  });
  assert.equal(plan.mode, "oauth");
  if (plan.mode === "oauth") {
    assert.equal(plan.token, "sk-ant-oat01-test");
    assert.equal(plan.cache, true); // OAuth path supports prompt caching
  }
});

test("accepts ANTHROPIC_AUTH_TOKEN as the OAuth source (caller maps it to oauthToken)", () => {
  const plan = planAnthropicAuth({ ...EMPTY, oauthToken: "sk-ant-oat01-test" });
  assert.equal(plan.mode, "oauth");
});

test("falls back to API key when no OAuth token is set", () => {
  const plan = planAnthropicAuth({ ...EMPTY, anthropicApiKey: "sk-ant-api03-test" });
  assert.equal(plan.mode, "api-key");
  if (plan.mode === "api-key") {
    assert.equal(plan.apiKey, "sk-ant-api03-test");
    assert.equal(plan.cache, true);
  }
});

test("a custom baseUrl forces API-key auth (OAuth only works on api.anthropic.com)", () => {
  const plan = planAnthropicAuth({
    ...EMPTY,
    oauthToken: "sk-ant-oat01-test",
    anthropicApiKey: "sk-ant-api03-test",
    baseUrl: "https://proxy.internal/v1",
  });
  assert.equal(plan.mode, "api-key");
  if (plan.mode === "api-key") {
    assert.equal(plan.cache, false); // compatible endpoints may reject cache_control
    assert.equal(plan.baseUrl, "https://proxy.internal/v1");
  }
});

test("custom baseUrl with no key at all → none", () => {
  const plan = planAnthropicAuth({ ...EMPTY, baseUrl: "https://proxy.internal/v1" });
  assert.equal(plan.mode, "none");
});

test("no credentials at all → none (caller degrades to rule-based)", () => {
  assert.equal(planAnthropicAuth(EMPTY).mode, "none");
});

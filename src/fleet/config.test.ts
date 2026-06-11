import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetConfig, resolveFleetEnv } from "./config";

test("fleetConfig exposes positive caps and a boolean live flag", () => {
  const c = fleetConfig();
  assert.equal(typeof c.live, "boolean");
  assert.ok(c.maxRounds >= 1);
  assert.ok(c.maxAgentSteps >= 1);
  assert.ok(c.maxConcurrency >= 1);
  assert.ok(c.buildTokenBudget > 0);
});

test("fleetConfig reads ANTHROPIC_API_KEY for the live flag", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal(fleetConfig().live, true);
  assert.equal(fleetConfig().authSource, "api-key");
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(fleetConfig().live, false);
  assert.equal(fleetConfig().authSource, "none");
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  if (prevOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevAuth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
});

test("authSource is 'subscription' when CLAUDE_CODE_OAUTH_TOKEN is set (preferred over api-key)", () => {
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-tok";
  process.env.ANTHROPIC_API_KEY = "sk-also-set";
  assert.equal(fleetConfig().authSource, "subscription");
  assert.equal(fleetConfig().live, true);
  if (prevOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
});

test("authSource is 'subscription' when ANTHROPIC_AUTH_TOKEN is set", () => {
  const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = "auth-tok";
  assert.equal(fleetConfig().authSource, "subscription");
  assert.equal(fleetConfig().live, true);
  if (prevAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
  if (prevOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
});

test("resolveFleetEnv strips ANTHROPIC_API_KEY when a platform subscription token is set", () => {
  // Claude Code prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN when both
  // reach the subprocess, which silently bills metered API credit instead of the
  // subscription ("Credit balance is too low" in prod, 2026-06-11). The fleet env
  // must enforce the documented subscription-first precedence itself.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-platform";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sub-tok";
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const env = resolveFleetEnv();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sub-tok");
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevAuth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
});

test("resolveFleetEnv keeps ANTHROPIC_API_KEY when no subscription token is set", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-platform";
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const env = resolveFleetEnv();
  assert.equal(env.ANTHROPIC_API_KEY, "sk-platform");
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevOAuth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevAuth !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
});

test("resolveFleetEnv with a tenant token strips platform creds and injects the tenant token", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevAuth = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-platform";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "platform-sub";
  process.env.ANTHROPIC_AUTH_TOKEN = "platform-auth";
  const env = resolveFleetEnv("tenant-tok");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tenant-tok");
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
  if (prevAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevAuth;
});

test("fleetConfig exposes budget + concurrency caps", () => {
  const c = fleetConfig();
  assert.ok(c.maxBudgetUsd > 0);
  assert.ok(c.maxConcurrentBuilds >= 1);
});

test("autodeploy defaults off; FLEET_AUTODEPLOY=on enables it", () => {
  const prev = process.env.FLEET_AUTODEPLOY;
  delete process.env.FLEET_AUTODEPLOY;
  assert.equal(fleetConfig().autodeploy, false);
  process.env.FLEET_AUTODEPLOY = "on";
  assert.equal(fleetConfig().autodeploy, true);
  process.env.FLEET_AUTODEPLOY = "true";
  assert.equal(fleetConfig().autodeploy, true);
  process.env.FLEET_AUTODEPLOY = "off";
  assert.equal(fleetConfig().autodeploy, false);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});

test("sandbox defaults to noop; FLEET_SANDBOX selects the backend", () => {
  const prev = process.env.FLEET_SANDBOX;
  delete process.env.FLEET_SANDBOX;
  assert.equal(fleetConfig().sandbox, "noop");
  process.env.FLEET_SANDBOX = "docker";
  assert.equal(fleetConfig().sandbox, "docker");
  if (prev === undefined) delete process.env.FLEET_SANDBOX; else process.env.FLEET_SANDBOX = prev;
});

test("sandboxTimeoutMs has a positive default and is env-overridable", () => {
  const prev = process.env.FLEET_SANDBOX_TIMEOUT_MS;
  delete process.env.FLEET_SANDBOX_TIMEOUT_MS;
  assert.ok(fleetConfig().sandboxTimeoutMs > 0);
  process.env.FLEET_SANDBOX_TIMEOUT_MS = "45000";
  assert.equal(fleetConfig().sandboxTimeoutMs, 45000);
  if (prev === undefined) delete process.env.FLEET_SANDBOX_TIMEOUT_MS; else process.env.FLEET_SANDBOX_TIMEOUT_MS = prev;
});

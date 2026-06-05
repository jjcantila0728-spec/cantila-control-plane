/* Tests for the one-line MCP installer scripts.
 *
 * `iwr -useb https://<host>/install.ps1 | iex` (and the `curl … | sh`
 * twin) must hand the user a script that registers THIS host's MCP
 * endpoint with the Claude Code CLI. The scripts are domain-agnostic:
 * whatever host served the script is the host the MCP is registered at,
 * so the same code works for api.cantila.app today and a branded
 * gritcode.cantila.app once DNS points at the control plane. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { installPs1, installSh } from "./script";

test("ps1 registers the MCP endpoint of the serving host", () => {
  const ps1 = installPs1("https://gritcode.cantila.app");
  assert.match(
    ps1,
    /claude mcp add --transport http cantila https:\/\/gritcode\.cantila\.app\/v1\/mcp/,
  );
});

test("ps1 guards on the claude CLI being present", () => {
  const ps1 = installPs1("https://api.cantila.app");
  assert.match(ps1, /Get-Command claude/);
});

test("sh registers the MCP endpoint of the serving host", () => {
  const sh = installSh("https://gritcode.cantila.app");
  assert.match(
    sh,
    /claude mcp add --transport http cantila https:\/\/gritcode\.cantila\.app\/v1\/mcp/,
  );
});

test("sh guards on the claude CLI being present", () => {
  const sh = installSh("https://api.cantila.app");
  assert.match(sh, /command -v claude/);
});

test("a custom server name is honoured in both scripts", () => {
  const ps1 = installPs1("https://gritcode.cantila.app", "gritcode");
  const sh = installSh("https://gritcode.cantila.app", "gritcode");
  assert.match(ps1, /claude mcp add --transport http gritcode /);
  assert.match(sh, /claude mcp add --transport http gritcode /);
});

test("a trailing slash on the base URL is normalised away", () => {
  const ps1 = installPs1("https://api.cantila.app/");
  assert.match(ps1, /https:\/\/api\.cantila\.app\/v1\/mcp/);
  assert.doesNotMatch(ps1, /cantila\.app\/\/v1/);
});

test("scripts only ever reference the given host (no hardcoded fallback host)", () => {
  const sh = installSh("https://gritcode.cantila.app");
  assert.doesNotMatch(sh, /api\.cantila\.app/);
});

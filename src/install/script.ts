/* One-line MCP installer scripts.
 *
 * Served as plain text from `GET /install.ps1` and `GET /install.sh` so a
 * user can run, on Windows:
 *
 *     iwr -useb https://gritcode.cantila.app/install.ps1 | iex
 *
 * or, on macOS/Linux:
 *
 *     curl -fsSL https://gritcode.cantila.app/install.sh | sh
 *
 * Both register THIS host's MCP endpoint (`<baseUrl>/v1/mcp`) with the
 * Claude Code CLI. The host is whatever served the script, so the same
 * code works for api.cantila.app today and a branded gritcode.cantila.app
 * the moment its DNS points at the control plane — there is no hardcoded
 * host. First use triggers the OAuth/Connect flow (or a static
 * `Authorization: Bearer ctk_live_…` if the user added one manually). */

const DEFAULT_SERVER_NAME = "cantila";

/** Strip a trailing slash so `${baseUrl}/v1/mcp` never doubles up. */
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** PowerShell installer for `iwr -useb …/install.ps1 | iex`. */
export function installPs1(
  baseUrl: string,
  serverName: string = DEFAULT_SERVER_NAME,
): string {
  const base = normaliseBaseUrl(baseUrl);
  const mcpUrl = `${base}/v1/mcp`;
  return `# Cantila MCP — one-line installer (PowerShell)
# Usage: iwr -useb ${base}/install.ps1 | iex
$ErrorActionPreference = 'Stop'
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "Claude Code CLI not found. Install it first: https://claude.com/claude-code" -ForegroundColor Yellow
  return
}
Write-Host "Registering the ${serverName} MCP server with Claude Code..." -ForegroundColor Cyan
claude mcp add --transport http ${serverName} ${mcpUrl}
Write-Host "Done. Run 'claude' and approve the ${serverName} connection — a browser sign-in opens on first use." -ForegroundColor Green
`;
}

/** POSIX-shell installer for `curl -fsSL …/install.sh | sh`. */
export function installSh(
  baseUrl: string,
  serverName: string = DEFAULT_SERVER_NAME,
): string {
  const base = normaliseBaseUrl(baseUrl);
  const mcpUrl = `${base}/v1/mcp`;
  return `#!/bin/sh
# Cantila MCP — one-line installer (POSIX shell)
# Usage: curl -fsSL ${base}/install.sh | sh
set -e
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found. Install it first: https://claude.com/claude-code"
  exit 1
fi
echo "Registering the ${serverName} MCP server with Claude Code..."
claude mcp add --transport http ${serverName} ${mcpUrl}
echo "Done. Run 'claude' and approve the ${serverName} connection — a browser sign-in opens on first use."
`;
}

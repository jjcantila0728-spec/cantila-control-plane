# Fleet Auth — Admin claude.ai Subscription for All Agents

> **§26 implementation guide.** Run the whole build fleet on the admin's claude.ai Max/Pro subscription instead of a metered `ANTHROPIC_API_KEY`.

## How it works

The Claude Agent SDK reads `CLAUDE_CODE_OAUTH_TOKEN` (and `ANTHROPIC_AUTH_TOKEN`) directly from the environment and applies it to the entire session — the orchestrator and all subagents spawned via the `Agent` tool inherit it, so a single token covers every agent in a build (and the remediation agent). No code passes the token through `query()` — the SDK picks it up automatically.

`fleetConfig()` resolves `authSource` in priority order:

| Priority | Env var | `authSource` |
|----------|---------|--------------|
| 1 (highest) | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` | `"subscription"` |
| 2 | `ANTHROPIC_API_KEY` | `"api-key"` |
| — (neither) | — | `"none"` |

`live` is `true` for both `subscription` and `api-key`. Boot log: `[fleet] auth: …`

## Setup

### Step 1 — Generate the token

On a trusted machine logged into the admin claude.ai Max/Pro subscription:

```
claude setup-token
```

Copy the printed long-lived token.

### Step 2 — Set it in Coolify

In the `cantila-control-plane` Coolify app environment variables:

```
CLAUDE_CODE_OAUTH_TOKEN=<your-token>
```

Add `?force=true` to the deploy URL to restart the container immediately, or trigger a redeploy.

### Step 3 — Verify the boot log

After redeploy, check the container logs:

```
[fleet] auth: claude.ai subscription (all agents)
```

Leave `ANTHROPIC_API_KEY` unset (or keep it as a fallback — subscription takes priority).

## Caveats

- **ToS:** a personal subscription powering the admin's own builds mirrors how OpenClaw uses Claude Code. Using it to serve *other tenants'* builds likely breaks Anthropic's Consumer Terms. This is opt-in via env.
- **Scope:** this covers the agent fleet (Agent SDK). The lightweight deploy planner/analyser (`src/ai/claude.ts`) uses the raw Messages API which does not accept subscription OAuth tokens — it still needs `ANTHROPIC_API_KEY` (or can be routed through the fleet later).
- **Rate limits:** one token = one subscription's limits. Future enhancement: pool several admin subscriptions with per-build round-robin (the SDK is one-token-per-session, so rotation is per build, not per subagent).

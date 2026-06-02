# MCP OAuth connector — design spec

**Date:** 2026-06-01
**Status:** Draft / not started
**Motivation:** Claude Code's "Connect via URL", and the claude.ai / Cowork
connector UIs, all drive an OAuth 2.0 sign-in + **Dynamic Client
Registration (DCR)** handshake. Our remote MCP server (`POST /v1/mcp`) is a
**static Bearer-token API only** — it implements no OAuth surface — so that
one-click flow fails with *"Couldn't register with Cantila CLI's sign-in
service… or add an OAuth Client ID."* Today the only working path is a
manually-pasted `Authorization: Bearer ctk_live_…` header (see `docs/mcp`).

This spec adds the OAuth surface so the **Connect button works with no
manual key**, while keeping the existing header/API-key path untouched.

## Evidence (root cause, verified 2026-06-01)

Against `https://mcp.cantila.app` (== `api.cantila.app`, same control plane):

| Probe | Observed | Should be (for OAuth) |
|---|---|---|
| `POST /v1/mcp` (no creds) | `401`, **no `WWW-Authenticate`** | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` |
| `GET /.well-known/oauth-protected-resource` | `401` (caught by blanket gate) | public JSON (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | `401` | public JSON w/ `registration_endpoint` (RFC 8414) |
| `POST /register` | `401` | `201` dynamic client creds (RFC 7591) |

Root: the `CANTILA_REQUIRE_AUTH` gate (`src/index.ts:413-507`) requires
`Bearer ctk_…`/`cts_…` on every path except `EXEMPT_PATHS`
(`src/index.ts:212-232`), which does not include the `.well-known/*`
discovery documents. No `/authorize`, `/token`, or `/register` route exists.

## Goal

A fresh MCP host can connect to `https://api.cantila.app/v1/mcp` by clicking
Connect → being redirected to a Cantila sign-in → consenting → and receiving
a token, with **no API key pasted by hand**. The host must be able to:
1. Discover the protected-resource + authorization-server metadata.
2. Dynamically register itself as a client (DCR).
3. Run the authorization-code + PKCE flow against Cantila.
4. Exchange the code for an access token usable as the MCP Bearer.

## Non-goals

- Replacing API-key auth. The `ctk_…` header path stays — it's the right
  fit for repo-scoped agents and CI.
- A full general-purpose OAuth provider. Scope is exactly what MCP hosts need.

## Design

### 1. Discovery metadata (RFC 9728 + RFC 8414)

Add two **un-authed** routes (add both paths to `EXEMPT_PATHS`):

- `GET /.well-known/oauth-protected-resource` →
  `{ resource: "https://api.cantila.app/v1/mcp",
     authorization_servers: ["https://api.cantila.app"] }`
- `GET /.well-known/oauth-authorization-server` →
  `{ issuer, authorization_endpoint, token_endpoint,
     registration_endpoint, code_challenge_methods_supported: ["S256"],
     grant_types_supported: ["authorization_code","refresh_token"],
     token_endpoint_auth_methods_supported: ["none"],
     scopes_supported: [...] }`

### 2. `WWW-Authenticate` on the MCP 401

In the auth gate, when the rejected path is `/v1/mcp`, emit:
`WWW-Authenticate: Bearer resource_metadata="https://api.cantila.app/.well-known/oauth-protected-resource"`
so a host that POSTs blind learns where to discover metadata.

### 3. Dynamic Client Registration (RFC 7591)

`POST /register` (un-authed, exempt): accept `{ client_name, redirect_uris,
grant_types, token_endpoint_auth_method }`, mint a public client
(`mcpc_…`), persist `{ client_id, redirect_uris }`, return `201`. Public
clients only (PKCE, no secret) — matches how MCP hosts register.

### 4. Authorization endpoint

`GET /authorize?response_type=code&client_id&redirect_uri&code_challenge&
code_challenge_method=S256&state&scope`:
- Validate `client_id` + `redirect_uri` against the registered client.
- If no active Console session (`cts_…`) → redirect into the existing
  `/v1/auth/*` login, returning here after. **Reuse the existing session
  layer — do not build a second identity system.**
- Render a minimal consent screen ("Allow <client_name> to act on
  <account> via Cantila MCP?"). On allow, mint a short-lived auth code bound
  to `{ client_id, redirect_uri, code_challenge, accountId, userId }`,
  redirect to `redirect_uri?code=…&state=…`.

### 5. Token endpoint

`POST /token` (un-authed; client auth is the code + PKCE verifier):
- `grant_type=authorization_code`: verify code + `code_verifier` against the
  stored `code_challenge`, then issue an access token. **Reuse the existing
  `cts_`/`ctk_` machinery** — simplest is to mint a scoped, account-bound
  token the existing `onRequest` resolver already understands, so `/v1/mcp`
  enforcement and tenant isolation need zero changes downstream.
- `grant_type=refresh_token`: rotate.

### 6. Tenant isolation

The issued token resolves to `{ accountId, userId }` exactly like a session,
so the MCP handler's existing `mcpAccountId` threading
(`src/index.ts:2938-2945`) confines every tool to the consenting account.
No change to tool code.

## Open questions

- **Account selection at consent** when the user owns multiple accounts —
  pick one at consent, or honor `X-Cantila-Act-As` post-auth? Lean: choose at
  consent, store on the token.
- **Scope granularity** — mirror API-key scopes (`read`/`deploy`/`admin`)
  as OAuth scopes, or grant full account scope like a session? Lean: mirror
  API-key scopes so a connected host can be least-privilege.
- **Token lifetime / refresh** — short access + refresh vs. long-lived.

## Test plan (TDD)

- Discovery docs return valid RFC-shaped JSON un-authed; both in
  `EXEMPT_PATHS`.
- `/v1/mcp` 401 carries the `WWW-Authenticate` resource_metadata pointer.
- DCR round-trips; rejects unregistered `redirect_uri`.
- authorization-code + PKCE happy path issues a working MCP Bearer; a wrong
  `code_verifier` is rejected.
- A token minted for account A cannot touch account B's projects (reuse
  `src/mcp/authz.test.ts` isolation assertions).
- End-to-end: real Claude Code "Connect via URL" against a local instance
  reaches the tool list with no manual header.

## Effort

Medium. The identity half already exists (`/v1/auth/*`, `cts_` sessions);
this is mostly the OAuth protocol shell (4 routes + 2 metadata docs + DCR
store) wired onto it. Estimate 1–2 focused sessions behind a plan.

# Auth live + session hardening, profile avatars, demo-account removal — design

**Date:** 2026-05-29
**Status:** APPROVED (2026-05-29, user said "proceed" with all recommended sub-choices accepted).
**Repos:** cantila-control-plane, cantila-console, cantila-cli.
**Relationship:** Builds on the already-implemented (uncommitted) social-login flow
(`2026-05-29-social-login-and-session-hardening-design.md`) and is the explicitly-flagged
`acc_demo` follow-up of `cantila-console/.../2026-05-29-remove-mock-data-design.md`.

## Goal

From the user's request — "remove all demo accounts, make the user auth live, handle
profile avatar in google and github sign in":

1. **Auth live + hardening** — the OAuth credentials are real and present, so Google +
   GitHub are already live; verify the live path and add the deferred session hardening
   (PKCE, id_token signature verification, login rate-limiting, session rotation).
2. **Profile avatars** — capture and surface the user's Google/GitHub profile picture.
3. **Remove all demo accounts** — full sweep of the `acc_demo` "Demo Account" default
   across control plane, console, and CLI.

## Locked decisions (2026-05-29)

- **Auth-live scope:** provision real OAuth (already configured — verify) **+** session
  hardening. (Auto-register hole already closed in a prior change.)
- **Demo removal:** **full sweep** (control plane seed + `acc_demo` defaults, Console
  defaults, CLI config).
- **Avatar storage:** **store the provider URL** on the User row (no self-hosting in v1).
- **Branch:** new dedicated `feat/auth-live-and-avatars` per repo, off current HEAD,
  isolated from the Telnyx / platform-mailboxes WIP.
- **Sub-choice 1 (JWKS):** use **`jose`** for RS256 id_token signature verification — a
  justified, narrowly-scoped dependency exception to the hand-rolled-adapter convention,
  because security crypto should not be hand-rolled.
- **Sub-choice 2 (avatar refresh):** on an existing user, **refresh `avatarUrl` only if it
  is currently empty** — never clobber (forward-compat with future custom uploads).
- **Stub backdoor:** `StubSsoProvider.completeLogin` will **refuse in production**
  (defense-in-depth). User may veto during spec review.

## Current state (verified by exploration)

- **Social login fully wired, uncommitted on `feat/telnyx-telephony`:**
  - Control plane: `src/auth/sso.ts` (registry → real `OidcSsoProvider` for Google,
    `GitHubOAuthProvider` for GitHub, stub fallback when env absent), `src/auth/sso-oidc.ts`
    (`email_verified === true` check), `src/auth/sso-github.ts`, `loginWithSso` /
    `beginSsoLogin` in `src/core/control-plane.ts`.
  - Auto-register hole already closed: `loginWithPassword` returns
    `"incorrect email or password"` for unknown email (control-plane.ts ~L5001).
  - Console: `src/app/(auth-public)/auth/callback/[provider]/route.ts`, state cookie
    (`cantila_oauth_state`, httpOnly, 10-min) + helpers in `src/lib/auth.ts`,
    `src/components/OAuthButtons.tsx`, signup posts to `/v1/auth/register`.
- **OAuth credentials present** in `cantila-control-plane/.env`:
  `CANTILA_GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `CANTILA_GITHUB_CLIENT_ID/SECRET/REDIRECT_URI`.
  Redirect URIs point at `https://cantila.app/auth/callback/{google,github}`.
- **No avatar field** on `User` (`prisma/schema.prisma` model User); `SsoProfile` has no
  avatar. Console renders **initials only** (Sidebar account chip, TeamView, MailView).
- **`acc_demo` "Demo Account"** wired across: control plane `DEFAULT_ACCOUNT_ID`
  (`src/index.ts:42`) + zod `.default("acc_demo")` (index.ts 659/713/736/741/747),
  `listProjects("acc_demo")` fallback (control-plane.ts ~L5930), three "Demo Account"
  spots in `src/domain/prisma-store.ts` (464/1295/1781), `src/domain/seed-platform.ts`;
  Console ~20 `accountId="acc_demo"` defaults in `src/lib/api.ts` + `MonitoringView.tsx:118`;
  CLI `src/config.ts:32`.

## Part A — Auth live + session hardening

### A1. Verify the live path
- Boot assertion / log line confirming `availableSsoProviders()` reports
  `google.live === true` and `github.live === true` when env is configured.
- **Manual config (documented, not code):** register BOTH the production
  (`https://cantila.app/auth/callback/{provider}`) and dev
  (`http://localhost:3000/auth/callback/{provider}`) redirect URIs in each provider's app
  settings. The control-plane env holds only the prod default; the Console passes its own
  origin's `redirectUri` at runtime, so both must be registered provider-side.

### A2. PKCE (S256) — Google only
- `/sso/start`: generate `code_verifier` (43–128 char) + `code_challenge =
  base64url(sha256(verifier))`; store the verifier in the httpOnly state cookie alongside
  `{state, from, provider}`; append `code_challenge` + `code_challenge_method=S256` to the
  Google authorize URL.
- `/sso/login` (token exchange): send `code_verifier`.
- **GitHub OAuth Apps do not support PKCE** — the client secret + state cookie remain the
  protection there. Documented asymmetry, not faked.

### A3. id_token signature verification (Google)
- Use **`jose`**: fetch and cache Google's JWKS (`createRemoteJWKSet` on
  `https://www.googleapis.com/oauth2/v3/certs`), verify the id_token RS256 signature plus
  `iss` (`https://accounts.google.com`), `aud` (client id), `exp`, before trusting claims.
- GitHub has no id_token (OAuth2 + `GET /user`) — signature verification N/A.

### A4. Login rate-limiting
- Fixed-window in-memory limiter on `/v1/auth/login`, `/v1/auth/register`,
  `/v1/auth/sso/login`, keyed by client IP (+ email where available). On exceed → 429.
- **Caveat (documented):** per-instance; multi-node would need a shared store (Redis).
  Acceptable for v1 single-node.

### A5. Session rotation
- Re-mint (rotate) the session token when it crosses a freshness threshold (sliding
  window) on `resolveSession`, issuing a new cookie and revoking the old hash.
- **Revoke all of a user's sessions on password change** (`changePassword`).

### A6. Stub backdoor kill (defense-in-depth)
- `StubSsoProvider.completeLogin` throws when running in production
  (`NODE_ENV === "production"` / `CANTILA_ENV`), so the fake-typed-email path can never be
  hit live. (Real providers are selected anyway when env is set; this is belt-and-braces.)

## Part B — Profile avatars (store provider URL)

- **Schema:** add `avatarUrl String?` to `User` + Prisma migration. Thread through
  `src/domain/types.ts` (`AuthUser`), `src/domain/store.ts` (create/update signatures),
  `src/domain/prisma-store.ts` (row mapping), and the in-memory store.
- **Capture:** add `avatarUrl?: string` to `SsoProfile` (`src/auth/sso.ts`).
  - Google: read the `picture` claim from the verified id_token.
  - GitHub: read `avatar_url` from `GET https://api.github.com/user`.
- **Persist:** `findOrCreateUser` accepts `avatarUrl`; sets it on create; on an existing
  user, **updates only when the stored value is empty** (no clobber).
- **Expose:** include `avatarUrl` on `/v1/me` and the `resolveSession` user shape; surface
  on `listMembers` rows where available (for TeamView).
- **Render (Console):** small `<Avatar url initials size>` component — `<img>` when a URL is
  present, initials fallback otherwise. Use for the signed-in user (profile/account menu +
  `SettingsView` account section) and `TeamView` member rows. Sidebar's chip stays
  account-initials (it represents the account, not the user).

## Part C — Remove all demo accounts (full sweep)

**Rule:** every affected route resolves the account from the **authenticated session**;
where there is no session context, return **400/401 instead of defaulting**.

- **Control plane:**
  - Remove `DEFAULT_ACCOUNT_ID = "acc_demo"` (`src/index.ts:42`) and the
    `.default("acc_demo")` zod defaults (index.ts 659/713/736/741/747) — make `accountId`
    required or session-derived per route (route-by-route audit task).
  - Remove the `listProjects("acc_demo")` fallback (control-plane.ts ~L5930).
  - Remove the three "Demo Account" auto-seed/upsert spots in `prisma-store.ts`
    (464/1295/1781) and any `acc_demo`/"Demo Account" in `seed-platform.ts`. A missing
    account becomes an explicit error, not an auto-vivified Demo Account.
- **Console:** remove the ~20 `accountId="acc_demo"` defaults in `src/lib/api.ts` and the
  `getMonitoring("acc_demo", …)` in `MonitoringView.tsx:118`; callers rely on the
  session-scoped account (control plane already scopes by session — query/body `accountId`
  becomes unnecessary or is passed from `/v1/me`).
- **CLI:** remove the `accountId:"acc_demo"` default in `src/config.ts:32` — require an
  authenticated context.

**Boundary with remove-mock-data spec:** that spec owns the *frontend mock fallback*; this
spec owns the *`acc_demo` account default*. No overlap in files beyond `api.ts` /
`MonitoringView` (coordinate edits; both are in this sweep's scope for the `acc_demo` lines
only).

## Branch & sequencing

- New `feat/auth-live-and-avatars` in each repo, created off current HEAD as the plan's
  first task. The uncommitted social-login work is the foundation and rides along; do not
  commit the unrelated Telnyx / platform-mailboxes WIP.
- Suggested order: (1) branch; (2) Part B schema + capture (small, isolated); (3) Part A
  hardening; (4) Part C sweep (widest blast radius, last); (5) verification.

## Testing / verification

- **Control plane** (has a test runner — `*.test.ts`): unit tests for PKCE
  challenge/verifier, JWKS verify (valid + tampered signature rejected), rate-limit window,
  avatar capture from Google `picture` / GitHub `avatar_url`, session rotation + revoke-on-
  password-change, and account-resolution-without-default (401/400 when no session).
- **Console:** `next build` typecheck; dev smoke against the live control plane — Google +
  GitHub round-trip, avatar renders with initials fallback, no `acc_demo` reachable.
- **Grep guard:** no `acc_demo` / "Demo Account" remaining outside tests/agents fixtures.

## Risks

- **Part C** has the widest blast radius (removing implicit defaults can surface 400/401 on
  any path that silently relied on `acc_demo`). Contained by the per-route audit and the
  derive-from-session-else-error rule. Rollback = revert the branch.
- **Part A3** touches security crypto — mitigated by using `jose` rather than hand-rolling.
- Multi-node rate-limiting is per-instance (documented caveat).

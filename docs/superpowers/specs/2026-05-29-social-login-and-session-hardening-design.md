# Social login (Google + GitHub) & session hardening — design

**Date:** 2026-05-29
**Status:** APPROVED (2026-05-29). User delegated the call ("I let you decide what's best"); Approach A and state-validation-in-baseline are both accepted. Proceeding to writing-plans. Signup-page target (`/auth/register`) to be verified during planning.
**Scope owner:** Cantila v1 auth hardening pass (the deferred "production hardening" the SSO stub comments reference).

## Goal

From the user's request — "enforce security and session" + "enable google and github login and signup":

1. Add **real** "Continue with Google" and "Continue with GitHub" login **and** signup, alongside the existing email/password.
2. Close the main security hole: stop `/login` from silently auto-registering unknown emails.

## Decisions (locked via AskUserQuestion, 2026-05-29)

- **Login methods:** email/password **+ Google + GitHub**. Retire the generic "Continue with SSO" stub button.
- **Credentials:** Build **real code, env-gated, stub fallback, infra-blocked to exercise** — matches the existing `OidcSsoProvider` pattern. Live once OAuth apps are registered. No credentials provisioned yet.
- **Security hardening scope:** **only "close the auto-register hole."** Explicitly **deferred:** PKCE, JWKS RS256 id_token signature verification, login rate-limiting, session rotation.
  - **Caveat (in baseline anyway):** OAuth `state` validation is intrinsic to a correct callback (ignoring it is a login-CSRF bug in the new code), so minimal state-cookie validation is part of the baseline flow, not an extra hardening item. User to veto if unwanted.

## Current state (as explored)

### Console (`cantila-console`, Next.js 14, no auth lib)
- Delegates all auth to the control plane over `/v1/auth/*`; stores `cantila_session` httpOnly cookie (SameSite=lax, secure in prod, domain `.cantila.app` in prod, host-only in dev). Helpers: `cantila-console/src/lib/auth.ts`.
- `cantila-console/src/middleware.ts` gates the `(console)` route group; public auth pages live on the apex (`cantila.app`); `/login`, `/signup`, `/forgot`, `/logout`, `/reset/`, `/verify/`, `/invite/` are public.
- Login page `cantila-console/src/app/(auth-public)/login/page.tsx`: two server actions — `signInWithPassword` → `/v1/auth/login`, `signInWithSso` → `/v1/auth/sso/login`. **The Google/GitHub buttons (`src/components/OAuthButtons.tsx`) currently submit the form's `email` field to the stub** — i.e. fake auth (trusts typed email, no redirect). This is what gets replaced.
- `establishSession(path, body)` POSTs to control plane, sets the session cookie on success. `safeFrom()` clamps open-redirects. `fetchSsoInfo()` reads `/v1/auth/sso/info`.

### Control plane (`cantila-control-plane`, Fastify 4 + Prisma 5)
- Auth routes in `cantila-control-plane/src/index.ts`:
  - `POST /v1/auth/login` → `loginWithPassword` (**auto-registers unknown email — the hole**)
  - `POST /v1/auth/register` → `registerUser` (explicit, fails if email taken)
  - `GET /v1/auth/sso/info`, `POST /v1/auth/sso/start` → `beginSsoLogin`, `POST /v1/auth/sso/login` → `loginWithSso`
  - `POST /v1/auth/session`, `POST /v1/auth/logout`, `/forgot`, `/reset-password`, `/verify-email/*`, `/account/me/change-password`
  - `/v1/auth/*` is exempt from API-key auth (`src/index.ts:420`).
- Sessions: `cts_<48hex>` opaque tokens, SHA-256 hash persisted, **7-day** expiry, auto-scoped to first membership. `mintSession` / `resolveSession` in `src/core/control-plane.ts` (~L4675 / L5171).
- SSO port: `src/auth/sso.ts` (`SsoProvider` interface, `StubSsoProvider`, `selectSsoProvider()` → single provider from `CANTILA_OIDC_*` env) and `src/auth/sso-oidc.ts` (`OidcSsoProvider` — authorize URL + code→token exchange + decode/validate `iss`/`aud`/`exp`/`email`; **no signature check**, **no `email_verified` check**, **`state` generated but not validated on callback**).
- `loginWithSso` → `ssoProvider.completeLogin` → `findOrCreateUser({email,name})` (keys on email) → `mintSession`.

### Key gaps vs. ask
1. Port supports **one** provider at a time; need **Google + GitHub simultaneously**.
2. **GitHub is OAuth2, not OIDC** (no `id_token`) — needs a sibling adapter that fetches `GET /user` + `/user/emails`.
3. `loginWithPassword` auto-registers (the hole).
4. `state` not validated on callback; buttons do a fake form-POST instead of a redirect.

## Approach A (RECOMMENDED) — provider registry + hand-rolled adapters

Generalize the single `ssoProvider` into a **registry** keyed by id (`"google"`, `"github"`), each built from env with stub fallback — same auto-select pattern as today. `SsoProvider` port unchanged, so routes + session minting keep their shape.

- **Google:** reuse `OidcSsoProvider` with Google's well-known endpoints (issuer `https://accounts.google.com`, authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`). Add an `email_verified === true` check.
- **GitHub:** new `GitHubOAuthProvider implements SsoProvider`. authorize `https://github.com/login/oauth/authorize`, token `https://github.com/login/oauth/access_token`, then `GET https://api.github.com/user` + `GET /user/emails` → use the **verified primary** email only.
- **Account linking:** `findOrCreateUser` keys on email; link only on **verified** email (Google `email_verified`, GitHub verified primary) to avoid takeover. (No new `AuthIdentity` table in v1 — documented constraint.)

### The flow (replaces fake form-POST)
```
/login --click Google--> Console server action
   - POST /v1/auth/sso/start {provider, redirectUri} -> {authorizeUrl, state}
   - set short-lived httpOnly cantila_oauth_state cookie {state, from, provider}
   - redirect(authorizeUrl) --> Google/GitHub consent
Provider --redirect ?code&state--> https://cantila.app/auth/callback/[provider]  (new Console route)
   - validate state == cookie.state  (CSRF guard)
   - POST /v1/auth/sso/login {provider, code, redirectUri} -> session token
   - set cantila_session cookie (existing shape); clear state cookie
   - redirect(safeFrom(from))
```
Callback lands on the **Console apex** so it can set `cantila_session` on `.cantila.app`. `redirect_uri` registered with each provider = `https://cantila.app/auth/callback/google` and `/github` (dev: `http://localhost:3000/auth/callback/<p>`).

### Env vars (new)
- `CANTILA_GOOGLE_CLIENT_ID`, `CANTILA_GOOGLE_CLIENT_SECRET`, `CANTILA_GOOGLE_REDIRECT_URI`
- `CANTILA_GITHUB_CLIENT_ID`, `CANTILA_GITHUB_CLIENT_SECRET`, `CANTILA_GITHUB_REDIRECT_URI`
- Provider absent ⇒ that button hidden / stub. `/v1/auth/sso/info` extended to list available providers + live flags.

### Close the auto-register hole
- `loginWithPassword`: unknown email ⇒ return `"incorrect email or password"` (no create).
- Signup stays explicit: `/signup` → `/v1/auth/register`. **Verify** the signup page posts to `/auth/register`, not `/auth/login` (TODO in plan).
- Social first-login find-or-create is intended ("login and signup" via social) and stays.

## Alternatives (rejected)
- **B — two hardcoded adapters + separate routes** (`/auth/google/*`, `/auth/github/*`): duplicates start/callback plumbing, diverges from `/auth/sso/*`, harder to add a 3rd provider.
- **C — OAuth library (Arctic / `@node-oauth`)**: adds a dependency, breaks the hand-rolled-adapter convention used by Stripe/AI/SSO ports.

## Files likely touched
**Control plane:** `src/auth/sso.ts` (registry), `src/auth/sso-oidc.ts` (`email_verified` check; Google preset), new `src/auth/sso-github.ts`, `src/index.ts` (provider param on start/login, sso/info shape), `src/core/control-plane.ts` (`loginWithPassword` hole fix; `beginSsoLogin`/`loginWithSso` take provider id).
**Console:** new `src/app/(auth-public)/auth/callback/[provider]/route.ts`, `src/lib/auth.ts` (state cookie helpers, start helper), `src/app/(auth-public)/login/page.tsx` + `signup/page.tsx` (server actions → redirect start), `src/components/OAuthButtons.tsx` (per-provider availability), `src/middleware.ts` (allowlist `/auth/callback/`).
**Config:** `.env.local` example + `src/config.ts` if env is centralized there.

## Resolved / next
1. Approach A — **approved**.
2. State validation in baseline — **approved** (PKCE/JWKS/rate-limit/rotation deferred).
3. Verify signup page targets `/auth/register` — during planning (first plan task).
4. Self-review done → writing-plans → implementation plan file.

## Spec self-review (2026-05-29)
- Placeholders: none. No TBD/TODO left except the deliberate "verify signup target" task.
- Consistency: flow, env vars, and file list agree; `SsoProvider` port unchanged across registry generalization.
- Scope: single implementation plan is appropriate (one feature, two repos, ~10 files). No decomposition needed.
- Ambiguity: account-linking rule made explicit (verified-email-only, no new table in v1); state handling made explicit (httpOnly state cookie, double-submit).

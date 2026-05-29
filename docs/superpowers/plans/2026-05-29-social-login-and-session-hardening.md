# Social Login (Google + GitHub) & Session Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake stub "Continue with Google/GitHub" buttons with a real redirect-based OAuth login+signup flow, and close the password auto-register hole.

**Architecture:** The control plane generalizes its single `ssoProvider` into a small **provider registry** keyed by id (`"google"`, `"github"`), each built from env vars with a stub fallback (same auto-select pattern as the existing `OidcSsoProvider`). Google reuses the OIDC adapter (Google is OIDC) with an added `email_verified` gate; GitHub is a new OAuth2 sibling that resolves the verified primary email via `GET /user` + `/user/emails`. The Console drives a browser redirect round-trip whose callback lands on the apex (`/auth/callback/[provider]`) so it can set the `cantila_session` cookie; a short-lived httpOnly state cookie guards against login-CSRF.

**Tech Stack:** Fastify 4 + Prisma 5 + TypeScript (control plane, run via `tsx`); Next.js 14 App Router (console). No new runtime dependencies. Tests: `node:test` run with `npx tsx <file>.test.ts` for pure helpers; `tsc` build + `curl` smoke tests for integration (the control plane ships no test runner today).

**Spec:** `docs/superpowers/specs/2026-05-29-social-login-and-session-hardening-design.md`

> **STATUS — IMPLEMENTED & REVIEWED (2026-05-29).** All 9 tasks done via subagent-driven execution; both repo halves passed spec-compliance + code-quality review (APPROVED). Control plane: commits `453fe73`, `bcb3bda`, `48dd0fe`, `6207c6f`, `6d30fba` on `feat/telnyx-telephony`. Console: `e18ff22`, `fcdd2e4`, `587ba87`, `bf6982e` on `main` (unpushed). `tsc` clean on both; pure-helper unit tests pass; stub round-trip verified via curl. **Infra-blocked (not a code gap):** exercising a *real* Google/GitHub login needs the OAuth apps registered + `CANTILA_GOOGLE_*` / `CANTILA_GITHUB_*` env vars (redirect URIs `https://cantila.app/auth/callback/{google,github}`); the browser end-to-end round-trip (Task 9 Step 2) is manual. Control-plane `.env.local` Google/GitHub var docs (Task 9 Step 1) still to add by hand (sibling-repo file the console subagent couldn't touch).

**Repos / paths:**
- Control plane: `c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-control-plane`
- Console: `c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-console`

---

## File Structure

**Control plane**
- Modify `src/auth/sso-oidc.ts` — add `email_verified` gate; export a Google preset factory.
- Create `src/auth/sso-github.ts` — `GitHubOAuthProvider` + pure `selectGithubPrimaryEmail()` helper.
- Create `src/auth/sso-github.test.ts` — node:test for the email-selection helper.
- Modify `src/auth/sso.ts` — provider **registry** (`ssoProviders`, `getSsoProvider`, `availableSsoProviders`), stub fallback per id.
- Modify `src/core/control-plane.ts` — `ssoInfo()` lists providers; `beginSsoLogin(provider, redirectUri)` and `loginWithSso({provider, code, ...})` take a provider id; `loginWithPassword` stops auto-creating.
- Modify `src/index.ts` — `/v1/auth/sso/info|start|login` carry the provider id.

**Console**
- Modify `src/lib/auth.ts` — OAuth state-cookie helpers + `beginOauth()` start helper + `fetchOauthProviders()`.
- Create `src/app/(auth-public)/auth/callback/[provider]/route.ts` — the OAuth callback route handler.
- Modify `src/app/(auth-public)/login/page.tsx` and `signup/page.tsx` — OAuth server actions redirect to the provider instead of form-POSTing the stub.
- Modify `src/components/OAuthButtons.tsx` — render only available providers.
- Modify `src/middleware.ts` — allowlist `/auth/callback/`.

**Config**
- Modify `.env.local` (and any `.env.example`) — new `CANTILA_GOOGLE_*` / `CANTILA_GITHUB_*` vars.

---

## Task 1: Close the password auto-register hole (control plane)

**Files:**
- Modify: `src/core/control-plane.ts` (`loginWithPassword`, ~L4716)

- [ ] **Step 1: Locate `loginWithPassword`** and read the `else { user = await this.findOrCreateUser(... passwordHash ...) }` branch that creates a user when `existing` is falsy.

- [ ] **Step 2: Make unknown email fail instead of auto-creating.** Replace the `else` branch so only a known email with a matching password succeeds:

```ts
    const existing = await this.deps.store.findUserByEmail(email);
    if (
      !existing ||
      !existing.passwordHash ||
      !verifyPassword(input.password, existing.passwordHash)
    ) {
      // No auto-register: unknown email and wrong password are
      // indistinguishable, so an attacker can't enumerate accounts.
      // New users sign up explicitly via /v1/auth/register.
      return { error: "incorrect email or password" };
    }
    const user = existing;
    const { token, expiresAt } = await this.mintSession(user.id);
```

Delete the now-unused `let user: AuthUser;` declaration and the old `if (existing) {...} else {...}` block. The `name` field on the input is no longer used here — leave the parameter for signature compatibility but it is ignored.

- [ ] **Step 3: Type-check.**

Run (in `cantila-control-plane`): `npm run build`
Expected: PASS (no type errors). If `AuthUser` import becomes unused, remove it.

- [ ] **Step 4: Smoke test the hole is closed.** Start the dev server (`npm run dev`) in one shell, then in another:

```bash
# Unknown email must NOT create an account or return a token:
curl -s -X POST localhost:8080/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"brand-new-nobody@example.com","password":"whatever"}'
```
Expected: HTTP 401, body `{"error":"incorrect email or password"}` — and NO `token` field.

- [ ] **Step 5: Commit.**

```bash
git add src/core/control-plane.ts
git commit -m "fix(auth): stop /login auto-registering unknown emails"
```

---

## Task 2: Add the GitHub OAuth2 provider (control plane)

**Files:**
- Create: `src/auth/sso-github.ts`
- Test: `src/auth/sso-github.test.ts`

- [ ] **Step 1: Write the failing test for the pure email-selection helper.**

`src/auth/sso-github.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGithubPrimaryEmail } from "./sso-github";

test("prefers the verified primary email", () => {
  const got = selectGithubPrimaryEmail([
    { email: "alt@x.com", primary: false, verified: true },
    { email: "main@x.com", primary: true, verified: true },
  ]);
  assert.equal(got, "main@x.com");
});

test("falls back to any verified email when no verified primary", () => {
  const got = selectGithubPrimaryEmail([
    { email: "main@x.com", primary: true, verified: false },
    { email: "alt@x.com", primary: false, verified: true },
  ]);
  assert.equal(got, "alt@x.com");
});

test("returns null when nothing is verified", () => {
  const got = selectGithubPrimaryEmail([
    { email: "main@x.com", primary: true, verified: false },
  ]);
  assert.equal(got, null);
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx tsx src/auth/sso-github.test.ts`
Expected: FAIL — cannot find module `./sso-github` (or `selectGithubPrimaryEmail` is not exported).

- [ ] **Step 3: Implement the provider.**

`src/auth/sso-github.ts`:
```ts
/* ============================================================
   GitHubOAuthProvider — OAuth2 (not OIDC) implementation of the
   SsoProvider port. GitHub issues no id_token, so completeLogin
   exchanges the code for an access token, then reads the verified
   primary email from the GitHub REST API. Same port, same call
   sites as OidcSsoProvider — selected by the registry in sso.ts
   when the CANTILA_GITHUB_* env vars are present.
   ============================================================ */

import type { SsoProfile, SsoProvider } from "./sso";

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Pick the email GitHub considers authoritative: the verified primary,
 *  else any verified email, else null (we refuse unverified emails to
 *  avoid account-takeover via email collision). */
export function selectGithubPrimaryEmail(emails: GithubEmail[]): string | null {
  const verifiedPrimary = emails.find((e) => e.primary && e.verified);
  if (verifiedPrimary) return verifiedPrimary.email.trim().toLowerCase();
  const anyVerified = emails.find((e) => e.verified);
  return anyVerified ? anyVerified.email.trim().toLowerCase() : null;
}

export interface GitHubOAuthProviderOpts {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

export class GitHubOAuthProvider implements SsoProvider {
  readonly live = true;
  readonly label = "GitHub";
  private opts: GitHubOAuthProviderOpts;

  constructor(opts: GitHubOAuthProviderOpts) {
    for (const [k, v] of Object.entries(opts)) {
      if (!v) throw new Error(`GitHubOAuthProvider: missing option "${k}"`);
    }
    this.opts = opts;
  }

  startLogin(input: { redirectUri: string; state: string }): {
    authorizeUrl: string;
  } {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", this.opts.clientId);
    u.searchParams.set("redirect_uri", this.opts.redirectUri);
    u.searchParams.set("scope", "read:user user:email");
    u.searchParams.set("state", input.state);
    return { authorizeUrl: u.toString() };
  }

  async completeLogin(input: { code?: string }): Promise<SsoProfile> {
    const code = input.code?.trim();
    if (!code) throw new Error("GitHub callback is missing the code");

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        code,
        redirect_uri: this.opts.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange rejected (HTTP ${tokenRes.status})`);
    }
    const token = (await tokenRes.json().catch(() => null)) as {
      access_token?: string;
    } | null;
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error("GitHub token response carried no access_token");

    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "cantila-control-plane",
    };

    const emailsRes = await fetch(EMAILS_URL, { headers: authHeaders });
    if (!emailsRes.ok) {
      throw new Error(`GitHub email lookup failed (HTTP ${emailsRes.status})`);
    }
    const emails = (await emailsRes.json().catch(() => [])) as GithubEmail[];
    const email = selectGithubPrimaryEmail(Array.isArray(emails) ? emails : []);
    if (!email) {
      throw new Error("GitHub account has no verified email");
    }

    let name: string | undefined;
    const userRes = await fetch(USER_URL, { headers: authHeaders });
    if (userRes.ok) {
      const profile = (await userRes.json().catch(() => null)) as {
        name?: unknown;
        login?: unknown;
      } | null;
      name =
        (typeof profile?.name === "string" && profile.name) ||
        (typeof profile?.login === "string" ? profile.login : undefined);
    }
    return { email, name: name ?? email.split("@")[0], provider: this.label };
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npx tsx src/auth/sso-github.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/auth/sso-github.ts src/auth/sso-github.test.ts
git commit -m "feat(auth): add GitHub OAuth2 SsoProvider with verified-email guard"
```

---

## Task 3: Gate Google on `email_verified` and add a Google preset (control plane)

**Files:**
- Modify: `src/auth/sso-oidc.ts`
- Test: `src/auth/sso-oidc.test.ts` (create)

- [ ] **Step 1: Write a failing test for the verified-email gate.** The current `completeLogin` does a network exchange, so test the smallest pure unit instead — extract claim validation into an exported pure function and test it.

`src/auth/sso-oidc.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailFromVerifiedClaims } from "./sso-oidc";

test("accepts a verified email", () => {
  assert.equal(
    emailFromVerifiedClaims({ email: "A@X.com", email_verified: true }),
    "a@x.com",
  );
});

test("rejects an unverified email", () => {
  assert.throws(() =>
    emailFromVerifiedClaims({ email: "a@x.com", email_verified: false }),
  );
});

test("rejects a missing email", () => {
  assert.throws(() => emailFromVerifiedClaims({ email_verified: true }));
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npx tsx src/auth/sso-oidc.test.ts`
Expected: FAIL — `emailFromVerifiedClaims` is not exported.

- [ ] **Step 3: Add the exported helper and call it from `completeLogin`.** In `src/auth/sso-oidc.ts`, add near the bottom helpers:

```ts
/** Extract the verified, normalized email from OIDC id_token claims.
 *  Throws if the email is missing/malformed OR `email_verified` is not
 *  strictly true — Google sets this; we refuse unverified emails so a
 *  social login can't take over an existing account by email collision. */
export function emailFromVerifiedClaims(
  claims: Record<string, unknown>,
): string {
  if (claims.email_verified !== true) {
    throw new Error("OIDC id_token email is not verified");
  }
  const email =
    typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("OIDC id_token did not carry a usable email claim");
  }
  return email;
}
```

Then in `completeLogin`, replace the inline `const email = typeof claims.email === "string" ? ... : "";` + regex block with:
```ts
    const email = emailFromVerifiedClaims(claims);
```
(Keep the existing `iss` / `aud` / `exp` checks above it unchanged.)

- [ ] **Step 4: Add the Google preset factory.** At the end of `src/auth/sso-oidc.ts`:

```ts
/** Build an OidcSsoProvider pre-wired to Google's OIDC endpoints from
 *  the CANTILA_GOOGLE_* env vars. Returns null when not configured so
 *  the registry can fall back to the stub. */
export function googleProviderFromEnv(): OidcSsoProvider | null {
  const e = process.env;
  if (
    !e.CANTILA_GOOGLE_CLIENT_ID ||
    !e.CANTILA_GOOGLE_CLIENT_SECRET ||
    !e.CANTILA_GOOGLE_REDIRECT_URI
  ) {
    return null;
  }
  const p = new OidcSsoProvider({
    issuer: "https://accounts.google.com",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: e.CANTILA_GOOGLE_CLIENT_ID,
    clientSecret: e.CANTILA_GOOGLE_CLIENT_SECRET,
    redirectUri: e.CANTILA_GOOGLE_REDIRECT_URI,
  });
  (p as { label: string }).label = "Google";
  return p;
}
```
(`label` is `readonly` on the instance; the cast re-labels the Google instance to "Google" instead of the generic `OIDC (issuer)` string. If `OidcSsoProvider` makes `label` truly immutable, add an optional `label?: string` to `OidcSsoProviderOpts` instead and use it in the constructor.)

- [ ] **Step 5: Run tests + build.**

Run: `npx tsx src/auth/sso-oidc.test.ts` → Expected: PASS (3 tests).
Run: `npm run build` → Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/auth/sso-oidc.ts src/auth/sso-oidc.test.ts
git commit -m "feat(auth): gate OIDC on email_verified; add Google preset factory"
```

---

## Task 4: Turn the single SSO provider into a registry (control plane)

**Files:**
- Modify: `src/auth/sso.ts`

- [ ] **Step 1: Replace the single-provider selection with a registry.** Keep the `SsoProfile` / `SsoProvider` interfaces and `StubSsoProvider` as-is. Replace `selectSsoProvider()` and the `export const ssoProvider` tail with:

```ts
import { OidcSsoProvider, googleProviderFromEnv } from "./sso-oidc";
import { GitHubOAuthProvider } from "./sso-github";

/** Provider ids the Console can request. */
export type SsoProviderId = "google" | "github";

function githubProviderFromEnv(): GitHubOAuthProvider | null {
  const e = process.env;
  if (
    !e.CANTILA_GITHUB_CLIENT_ID ||
    !e.CANTILA_GITHUB_CLIENT_SECRET ||
    !e.CANTILA_GITHUB_REDIRECT_URI
  ) {
    return null;
  }
  return new GitHubOAuthProvider({
    clientId: e.CANTILA_GITHUB_CLIENT_ID,
    clientSecret: e.CANTILA_GITHUB_CLIENT_SECRET,
    redirectUri: e.CANTILA_GITHUB_REDIRECT_URI,
  });
}

/** Build the registry once at boot. A provider with no env config falls
 *  back to a labelled StubSsoProvider so the dev flow still round-trips
 *  and the Console can render the button with a "(stub)" badge. */
function buildRegistry(): Record<SsoProviderId, SsoProvider> {
  const stub = (label: string): SsoProvider => {
    const s = new StubSsoProvider();
    (s as { label: string }).label = label;
    return s;
  };
  return {
    google: googleProviderFromEnv() ?? stub("Google (stub)"),
    github: githubProviderFromEnv() ?? stub("GitHub (stub)"),
  };
}

const registry = buildRegistry();

/** Look up a provider by id; throws on an unknown id. */
export function getSsoProvider(id: string): SsoProvider {
  const p = (registry as Record<string, SsoProvider | undefined>)[id];
  if (!p) throw new Error(`unknown SSO provider "${id}"`);
  return p;
}

/** List the configured providers for the Console login page. */
export function availableSsoProviders(): Array<{
  id: SsoProviderId;
  label: string;
  live: boolean;
}> {
  return (Object.keys(registry) as SsoProviderId[]).map((id) => ({
    id,
    label: registry[id].label,
    live: registry[id].live,
  }));
}
```

Note: `OidcSsoProvider` stays imported because `googleProviderFromEnv` returns one; keep the import even if not directly referenced here (or import only `googleProviderFromEnv`). Remove the old `export const ssoProvider`.

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: FAIL — `src/core/control-plane.ts` and `src/index.ts` still import the removed `ssoProvider`. That is expected; Tasks 5–6 fix the call sites. (If you prefer green-between-tasks, do Steps 1 here and the call-site edits in Task 5 in the same commit.)

- [ ] **Step 3: Commit (with Task 5).** Defer the commit until Task 5 compiles, since these are one logical change. Skip committing here.

---

## Task 5: Thread the provider id through the control-plane API (control plane)

**Files:**
- Modify: `src/core/control-plane.ts` (`ssoInfo`, `beginSsoLogin`, `loginWithSso`)
- Modify: `src/index.ts` (`/v1/auth/sso/info|start|login`)

- [ ] **Step 1: Update the import and the three methods in `control-plane.ts`.** Change the import at L96 from `{ ssoProvider, type SsoProfile }` to:

```ts
import {
  getSsoProvider,
  availableSsoProviders,
  type SsoProfile,
} from "../auth/sso";
```

Replace `ssoInfo()`:
```ts
  /** The configured SSO providers, for the Console login/signup pages. */
  ssoInfo(): { providers: Array<{ id: string; label: string; live: boolean }> } {
    return { providers: availableSsoProviders() };
  }
```

Replace `beginSsoLogin` to take a provider id:
```ts
  beginSsoLogin(
    provider: string,
    redirectUri: string,
  ): { authorizeUrl: string; provider: string } {
    const p = getSsoProvider(provider);
    const state = randomBytes(12).toString("hex");
    const { authorizeUrl } = p.startLogin({ redirectUri, state });
    return { authorizeUrl, provider: p.label };
  }
```
(The `state` returned to the caller is added in Step 2 below so the Console can store it.)

Replace `loginWithSso` to take a provider id:
```ts
  async loginWithSso(input: {
    provider: string;
    code?: string;
    email?: string;
  }): Promise<
    | { token: string; expiresAt: string; user: { id: string; email: string; name: string } }
    | { error: string }
  > {
    let profile: SsoProfile;
    try {
      profile = await getSsoProvider(input.provider).completeLogin(input);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "SSO login failed" };
    }
    const user = await this.findOrCreateUser({ email: profile.email, name: profile.name });
    const { token, expiresAt } = await this.mintSession(user.id);
    return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } };
  }
```

- [ ] **Step 2: Return `state` from `beginSsoLogin` so the Console can persist it.** Adjust the return type to `{ authorizeUrl: string; provider: string; state: string }` and include `state` in the returned object.

- [ ] **Step 3: Update the routes in `index.ts`.** `sso/info` is unchanged in shape (it just forwards `cp.ssoInfo()`). Update the `start` and `login` schemas + handlers:

```ts
// near the other zod schemas:
const ssoStartSchema = z.object({
  provider: z.enum(["google", "github"]),
  redirectUri: z.string().url(),
});
const ssoLoginSchema = z.object({
  provider: z.enum(["google", "github"]),
  code: z.string().optional(),
  email: z.string().optional(),
});
```
```ts
app.post("/v1/auth/sso/start", async (request, reply) => {
  const parsed = ssoStartSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return reply.code(200).send(
    cp.beginSsoLogin(parsed.data.provider, parsed.data.redirectUri),
  );
});

app.post("/v1/auth/sso/login", async (request, reply) => {
  const parsed = ssoLoginSchema.safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const result = await cp.loginWithSso(parsed.data);
  if ("error" in result) return reply.code(401).send({ error: result.error });
  return reply.code(200).send(result);
});
```

- [ ] **Step 4: Build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Smoke test the provider list + stub round-trip.** With `npm run dev` running (no Google/GitHub env vars set, so both are stubs):

```bash
curl -s localhost:8080/v1/auth/sso/info
# Expected: {"providers":[{"id":"google","label":"Google (stub)","live":false},{"id":"github","label":"GitHub (stub)","live":false}]}

curl -s -X POST localhost:8080/v1/auth/sso/start -H 'content-type: application/json' \
  -d '{"provider":"google","redirectUri":"http://localhost:3000/auth/callback/google"}'
# Expected: JSON with authorizeUrl (stub points back at redirectUri with ?state=...&stub=1), provider, state

curl -s -X POST localhost:8080/v1/auth/sso/login -H 'content-type: application/json' \
  -d '{"provider":"google","email":"dev@example.com"}'
# Expected: 200 with token, expiresAt, user (stub trusts the email)
```

- [ ] **Step 6: Commit (Tasks 4 + 5 together).**

```bash
git add src/auth/sso.ts src/core/control-plane.ts src/index.ts
git commit -m "feat(auth): multi-provider SSO registry; thread provider id through API"
```

---

## Task 6: OAuth state-cookie + start helpers (console)

**Files:**
- Modify: `src/lib/auth.ts`

- [ ] **Step 1: Add the state-cookie constant and helpers.** Append to `src/lib/auth.ts`:

```ts
import { randomBytes } from "node:crypto";

/** Short-lived cookie carrying the OAuth `state`, the originating
 *  `from` path, and the provider id between /login and the callback.
 *  httpOnly + 10-minute lifetime; cleared on callback. */
export const OAUTH_STATE_COOKIE = "cantila_oauth_state";

/** Begin an OAuth login: ask the control plane for the authorize URL,
 *  stash {state, from, provider} in an httpOnly cookie, and return the
 *  URL the caller should redirect the browser to. Returns null on
 *  failure (caller redirects back with an error). */
export async function beginOauth(
  provider: "google" | "github",
  from: string,
): Promise<string | null> {
  const redirectUri = `${oauthBaseUrl()}/auth/callback/${provider}`;
  let data: { authorizeUrl?: string; state?: string } | null = null;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/auth/sso/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, redirectUri }),
      cache: "no-store",
    });
    data = (await res.json().catch(() => null)) as typeof data;
    if (!res.ok || !data?.authorizeUrl || !data?.state) return null;
  } catch {
    return null;
  }
  cookies().set(
    OAUTH_STATE_COOKIE,
    JSON.stringify({ state: data.state, from, provider }),
    { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production", maxAge: 600, domain: undefined },
  );
  return data.authorizeUrl;
}

/** The public origin the OAuth callback is registered under. Mirrors the
 *  apex host the middleware serves the auth pages on. */
function oauthBaseUrl(): string {
  return (
    process.env.CANTILA_PUBLIC_ORIGIN ??
    (process.env.NODE_ENV === "production"
      ? "https://cantila.app"
      : "http://localhost:3000")
  );
}

/** Validate and consume the state cookie on callback. Returns the stored
 *  {from, provider} when `presentedState` matches, else null. Always
 *  clears the cookie. */
export function consumeOauthState(
  presentedState: string | undefined,
): { from: string; provider: string } | null {
  const raw = cookies().get(OAUTH_STATE_COOKIE)?.value;
  cookies().delete(OAUTH_STATE_COOKIE);
  if (!raw || !presentedState) return null;
  try {
    const parsed = JSON.parse(raw) as { state?: string; from?: string; provider?: string };
    if (!parsed.state || parsed.state !== presentedState) return null;
    return { from: typeof parsed.from === "string" ? parsed.from : "/dashboard", provider: parsed.provider ?? "" };
  } catch {
    return null;
  }
}

/** Fetch the configured providers so the buttons reflect what is wired.
 *  Never throws. */
export async function fetchOauthProviders(): Promise<
  Array<{ id: string; label: string; live: boolean }>
> {
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/auth/sso/info`, { cache: "no-store" });
    if (res.ok) {
      const info = (await res.json()) as { providers?: unknown };
      if (Array.isArray(info.providers)) return info.providers as Array<{ id: string; label: string; live: boolean }>;
    }
  } catch {
    /* control plane unreachable */
  }
  return [];
}
```

`fetchSsoInfo()` (old single-provider helper) is now superseded by `fetchOauthProviders()`; leave it in place until Task 8 removes its last caller, then delete it.

- [ ] **Step 2: Build the console.**

Run (in `cantila-console`): `npm run build`
Expected: PASS (helpers are unused so far — that is fine; Next tree-shakes server code). If the build flags an unused import, ignore until wired in Task 8, or proceed to Task 7/8 first then build once.

- [ ] **Step 3: Commit.**

```bash
git add src/lib/auth.ts
git commit -m "feat(console): OAuth state-cookie + start/provider-list helpers"
```

---

## Task 7: OAuth callback route (console)

**Files:**
- Create: `src/app/(auth-public)/auth/callback/[provider]/route.ts`

- [ ] **Step 1: Implement the callback GET handler.**

```ts
/* OAuth callback — the IdP redirects the browser here with ?code&state.
   We validate state against the httpOnly cookie set at /login (CSRF
   guard), exchange the code at the control plane, set the session
   cookie, and bounce to the originating page. */
import { NextResponse, type NextRequest } from "next/server";
import {
  CONTROL_PLANE_URL,
  SESSION_COOKIE,
  consumeOauthState,
  safeFrom,
  sessionCookieOptions,
} from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: { provider: string } },
) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;
  const origin = url.origin;

  const fail = (msg: string) =>
    NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`);

  const stored = consumeOauthState(state);
  if (!stored || stored.provider !== params.provider) {
    return fail("sign-in expired or was tampered with — please try again");
  }
  if (!code) return fail("sign-in was cancelled");

  let data: { token?: string; expiresAt?: string; error?: unknown } | null = null;
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/auth/sso/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: params.provider, code }),
      cache: "no-store",
    });
    data = (await res.json().catch(() => null)) as typeof data;
    if (!res.ok || !data?.token) {
      return fail(
        data && typeof data.error === "string" ? data.error : "sign-in failed",
      );
    }
  } catch {
    return fail("could not reach the control plane");
  }

  const res = NextResponse.redirect(`${origin}${safeFrom(stored.from)}`);
  res.cookies.set(
    SESSION_COOKIE,
    data.token,
    sessionCookieOptions({ expires: data.expiresAt }),
  );
  return res;
}
```

`CONTROL_PLANE_URL`, `SESSION_COOKIE`, `safeFrom`, `sessionCookieOptions` already exist in `src/lib/auth.ts`; `consumeOauthState` was added in Task 6.

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: PASS, and the route `/auth/callback/[provider]` appears in the route manifest.

- [ ] **Step 3: Commit.**

```bash
git add "src/app/(auth-public)/auth/callback/[provider]/route.ts"
git commit -m "feat(console): OAuth callback route with state validation"
```

---

## Task 8: Wire the buttons to the redirect flow + allowlist the callback (console)

**Files:**
- Modify: `src/components/OAuthButtons.tsx`
- Modify: `src/app/(auth-public)/login/page.tsx`
- Modify: `src/app/(auth-public)/signup/page.tsx`
- Modify: `src/middleware.ts`

- [ ] **Step 1: Allowlist the callback path in middleware.** In `src/middleware.ts`, add `"/auth/callback/"` to `PUBLIC_AUTH_PREFIXES` (alongside `"/invite/"`, `"/reset/"`, `"/verify/"`) so the signed-out browser can reach the callback:

```ts
const PUBLIC_AUTH_PREFIXES = [
  "/invite/",
  "/reset/",
  "/verify/",
  "/auth/callback/",
  ...PUBLIC_ONLY_PREFIXES.map((p) => p + "/"),
  ...PUBLIC_ONLY_PREFIXES,
];
```

- [ ] **Step 2: Replace the login page OAuth action with a redirect start.** In `login/page.tsx`, replace `signInWithSso` with:

```ts
async function startOauth(formData: FormData) {
  "use server";
  const from = formData.get("from") as string | null;
  const provider = String(formData.get("provider") ?? "");
  if (provider !== "google" && provider !== "github") {
    redirect(`/login?error=${encodeURIComponent("unknown provider")}`);
  }
  const authorizeUrl = await beginOauth(provider, safeFrom(from));
  if (!authorizeUrl) {
    const fromQs = from ? `&from=${encodeURIComponent(from)}` : "";
    redirect(`/login?error=${encodeURIComponent("could not start sign-in")}${fromQs}`);
  }
  redirect(authorizeUrl);
}
```
Update imports: replace `fetchSsoInfo` with `beginOauth, fetchOauthProviders`. Replace the `const sso = await fetchSsoInfo();` line with `const providers = await fetchOauthProviders();`. Pass `providers` into `<OAuthButtons action={startOauth} providers={providers} />`. Update the footer line to reflect provider liveness (e.g. show "(stub)" when none are `live`).

- [ ] **Step 3: Mirror the change in `signup/page.tsx`.** Replace `continueWithProvider` with the same `startOauth` body but redirecting back to `/signup` on error, and add `providers` + the `beginOauth`/`fetchOauthProviders` imports. The OAuth flow is identical for login and signup (find-or-create), so both pages start the same redirect.

- [ ] **Step 4: Make `OAuthButtons` render only configured providers.** Update `src/components/OAuthButtons.tsx`:

```tsx
export default function OAuthButtons({
  action,
  providers,
}: {
  action: (formData: FormData) => void;
  providers: Array<{ id: string; label: string; live: boolean }>;
}) {
  const ids = new Set(providers.map((p) => p.id));
  const show = (id: string) => ids.size === 0 || ids.has(id); // show both if list empty (stub/dev)
  return (
    <div className="grid grid-cols-2 gap-2">
      {show("google") && (
        <button type="submit" formAction={action} name="provider" value="google" className={BTN}>
          <GoogleIcon className="h-4 w-4" /> Google
        </button>
      )}
      {show("github") && (
        <button type="submit" formAction={action} name="provider" value="github" className={BTN}>
          <Github className="h-4 w-4" /> GitHub
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Remove the dead `fetchSsoInfo` helper.** Delete `fetchSsoInfo` from `src/lib/auth.ts` now that no page imports it. Confirm with: `grep -rn "fetchSsoInfo" src` → Expected: no matches.

- [ ] **Step 6: Build.**

Run: `npm run build`
Expected: PASS, no unused-import warnings, `/auth/callback/[provider]` still in the manifest.

- [ ] **Step 7: Commit.**

```bash
git add src/components/OAuthButtons.tsx "src/app/(auth-public)/login/page.tsx" "src/app/(auth-public)/signup/page.tsx" src/middleware.ts src/lib/auth.ts
git commit -m "feat(console): redirect-based Google/GitHub login+signup; allowlist callback"
```

---

## Task 9: End-to-end stub round-trip + env documentation

**Files:**
- Modify: `.env.local` (control plane) and any `.env.example`

- [ ] **Step 1: Document the new env vars.** Add to the control-plane `.env.local` (commented, since unset = stub):

```bash
# Social login — set to go live (else the buttons run the bundled stub).
# Google OAuth (OIDC): https://console.cloud.google.com/apis/credentials
#   Authorized redirect URI: https://cantila.app/auth/callback/google
# CANTILA_GOOGLE_CLIENT_ID=
# CANTILA_GOOGLE_CLIENT_SECRET=
# CANTILA_GOOGLE_REDIRECT_URI=https://cantila.app/auth/callback/google
# GitHub OAuth: https://github.com/settings/developers
#   Authorization callback URL: https://cantila.app/auth/callback/github
# CANTILA_GITHUB_CLIENT_ID=
# CANTILA_GITHUB_CLIENT_SECRET=
# CANTILA_GITHUB_REDIRECT_URI=https://cantila.app/auth/callback/github
```
Also note `CANTILA_PUBLIC_ORIGIN` (console) defaults to `https://cantila.app` in prod / `http://localhost:3000` in dev.

- [ ] **Step 2: Full stub round-trip.** Run control plane (`npm run dev`, port 8080) and console (`npm run dev`, port 3000), both with no Google/GitHub env vars. In a browser:
  1. Open `http://localhost:3000/login`. Both Google + GitHub buttons render (stub mode).
  2. Click **Google**. The server action calls `/sso/start`, sets the `cantila_oauth_state` cookie, and redirects. The stub authorizeUrl points back at `http://localhost:3000/auth/callback/google?state=...&stub=1` (no `code`).
  3. Because the stub returns no `code`, the callback redirects to `/login?error=sign-in was cancelled`. **This is expected for the stub** — it proves state validation + routing work without a real IdP.

Expected: state cookie is set then cleared; no crash; error surfaces cleanly. (A real `code` only arrives from a live Google/GitHub app — infra-blocked until registered.)

- [ ] **Step 3: Verify the auto-register hole stays closed (regression).**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST localhost:8080/v1/auth/login \
  -H 'content-type: application/json' -d '{"email":"nobody-new@example.com","password":"x"}'
```
Expected: `401`.

- [ ] **Step 4: Commit.**

```bash
git add .env.local .env.example 2>/dev/null; git commit -m "docs(auth): document social-login env vars; verify stub round-trip"
```

---

## Self-Review

**Spec coverage:**
- Google + GitHub login → Tasks 2–8. ✓
- Login = signup via social (find-or-create) → `loginWithSso` (Task 5) + shared start on both pages (Task 8). ✓
- Env-gated, stub fallback → registry stubs (Task 4) + presets (Tasks 2–3) + env docs (Task 9). ✓
- Retire generic SSO button → `OAuthButtons` renders only google/github; `fetchSsoInfo` removed (Task 8). ✓
- Close auto-register hole → Task 1, regression in Task 9. ✓
- State validation in baseline → state cookie (Task 6) + callback check (Task 7). ✓
- Verified-email-only linking → GitHub (Task 2) + Google `email_verified` (Task 3). ✓
- Deferred (PKCE/JWKS/rate-limit/rotation) → not in any task, by design. ✓

**Placeholder scan:** none — every code step has full code; commands have expected output.

**Type consistency:** `getSsoProvider`/`availableSsoProviders` (Task 4) used identically in Task 5; `beginSsoLogin(provider, redirectUri)→{authorizeUrl,provider,state}` matches `beginOauth` (Task 6) and `/sso/start` schema (Task 5); `loginWithSso({provider,code})` matches the callback POST (Task 7) and `/sso/login` schema (Task 5); `consumeOauthState`/`OAUTH_STATE_COOKIE`/`beginOauth`/`fetchOauthProviders` defined in Task 6 and consumed in Tasks 7–8; `selectGithubPrimaryEmail`/`emailFromVerifiedClaims` defined and tested in Tasks 2–3.

**Known follow-ups (out of scope, noted for later):** no `AuthIdentity` table (linking by verified email only); session rotation, PKCE, JWKS RS256, and login rate-limiting remain deferred per the spec.

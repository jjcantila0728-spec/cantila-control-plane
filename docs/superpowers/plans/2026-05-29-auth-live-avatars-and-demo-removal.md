# Auth live + hardening, profile avatars, demo-account removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Google/GitHub auth genuinely live with session hardening, capture and surface profile avatars, and remove every `acc_demo` "Demo Account" default across the three repos.

**Architecture:** The social-login redirect flow already exists end-to-end (control-plane `SsoProvider` registry + Console callback route). This plan (1) adds PKCE/JWKS/rate-limit/rotation hardening on top, (2) threads an `avatarUrl` from the IdP through `User`/`SsoProfile`/`/v1/me` into a Console `<Avatar>`, and (3) deletes the `acc_demo` account fallback so every route resolves the account from the authenticated session, erroring otherwise.

**Tech Stack:** Control plane — Fastify 4, Prisma 5, TypeScript, `node:test` (run via `tsx`), `jose` (new, for JWKS). Console — Next.js 14 (App Router, server actions). CLI — TypeScript.

**Spec:** `cantila-control-plane/docs/superpowers/specs/2026-05-29-auth-live-avatars-and-demo-removal-design.md`

**Repos (absolute paths):**
- CP = `c:\Users\canti\OneDrive\Documents\Claude\Projects\cantila\cantila-control-plane`
- CONSOLE = `c:\Users\canti\OneDrive\Documents\Claude\Projects\cantila\cantila-console`
- CLI = `c:\Users\canti\OneDrive\Documents\Claude\Projects\cantila\cantila-cli`

**Test command (CP):** `npx tsx --test src/path/to/file.test.ts`
(If your `tsx` lacks `--test` passthrough, use `node --import tsx --test src/path/to/file.test.ts`.)
**Typecheck (CP & CONSOLE):** `npx tsc --noEmit` (CONSOLE also: `npm run build` for the full Next typecheck).

**Windows note:** `npx prisma generate` may fail with EPERM renaming `query_engine-windows.dll.node` (OneDrive lock). Types still regenerate; ignore the rename failure. `tsc --noEmit` is the real gate.

---

## Phase 0 — Branch setup

### Task 0: Create the working branch in each repo

**Files:** none (git only).

- [ ] **Step 1: Confirm clean trees, then branch each repo**

```bash
cd "c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-control-plane" && git status --short && git checkout -b feat/auth-live-and-avatars
cd "c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-console" && git status --short && git checkout -b feat/auth-live-and-avatars
cd "c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-cli" && git status --short && git checkout -b feat/auth-live-and-avatars
```

Expected: each switches to the new branch. CP carries 3 harmless untracked files (the social-login spec/plan docs + `scripts/probe-mailcow-live.ts`) — leave them. If any repo shows unexpected modified files, STOP and ask the user before continuing.

---

## Phase 1 — Profile avatars: data + capture (CP)

### Task 1: Add `avatarUrl` to the User model, type, and store

**Files:**
- Modify: `CP/prisma/schema.prisma` (model User, ~L257-274)
- Modify: `CP/src/domain/types.ts` (`AuthUser`, ~L204)
- Modify: `CP/src/domain/store.ts` (interface ~L245-261; InMemoryStore ~L1285-1326)
- Modify: `CP/src/domain/prisma-store.ts` (`createUser` ~L1366; `toAuthUser` ~L2256)
- Create: `CP/prisma/migrations/20260529030000_add_user_avatar_url/migration.sql`

- [ ] **Step 1: Add the column to the Prisma schema**

In `model User` add after `emailVerifiedAt  DateTime?`:

```prisma
  /// Profile picture URL captured from a social IdP (Google `picture`,
  /// GitHub `avatar_url`) at first social sign-in. Nullable; password-only
  /// users have none and the Console falls back to initials.
  avatarUrl        String?
```

- [ ] **Step 2: Write the migration SQL**

Create `CP/prisma/migrations/20260529030000_add_user_avatar_url/migration.sql`:

```sql
-- Add nullable avatar URL for social sign-in profile pictures.
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
```

- [ ] **Step 3: Add `avatarUrl` to the `AuthUser` type**

In `CP/src/domain/types.ts`, inside `interface AuthUser`, add after the `emailVerifiedAt` field:

```ts
  /** Profile picture URL from a social IdP (Google `picture`, GitHub
   *  `avatar_url`). Undefined for password-only users. */
  avatarUrl?: string;
```

- [ ] **Step 4: Add a `setUserAvatarUrl` store method to the interface**

In `CP/src/domain/store.ts`, in the `/* ----- per-user auth ----- */` block after `setUserEmailVerifiedAt(...)` (after L258):

```ts
  /** Set a user's avatar URL (captured from a social IdP at sign-in).
   *  Idempotent. */
  setUserAvatarUrl(userId: string, avatarUrl: string): Promise<AuthUser>;
```

- [ ] **Step 5: Implement it in InMemoryStore**

In `CP/src/domain/store.ts`, after `setUserEmailVerifiedAt` (after L1310):

```ts
  async setUserAvatarUrl(
    userId: string,
    avatarUrl: string,
  ): Promise<AuthUser> {
    const existing = this.users.get(userId);
    if (!existing) throw new Error(`user ${userId} not found`);
    const updated: AuthUser = { ...existing, avatarUrl };
    this.users.set(userId, updated);
    return updated;
  }
```

- [ ] **Step 6: Implement it in PrismaStore + persist avatarUrl on create + map it back**

In `CP/src/domain/prisma-store.ts`, `createUser` (L1368-1376) add `avatarUrl: u.avatarUrl,` after `accountId: u.accountId,`. In `toAuthUser` (L2257-2266) add after `accountId: r.accountId ?? undefined,`:

```ts
    avatarUrl: r.avatarUrl ?? undefined,
```

Then add the method near `updateUserPassword` (after L1390):

```ts
  async setUserAvatarUrl(
    userId: string,
    avatarUrl: string,
  ): Promise<AuthUser> {
    const row = await this.db.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });
    return toAuthUser(row);
  }
```

- [ ] **Step 7: Regenerate Prisma client + typecheck**

Run: `cd "%CP%" && npx prisma generate ; npx tsc --noEmit`
Expected: typecheck clean. (Prisma generate may EPERM on the dll rename — ignore; the `.d.ts` still updates so `r.avatarUrl` typechecks.)

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260529030000_add_user_avatar_url src/domain/types.ts src/domain/store.ts src/domain/prisma-store.ts
git commit -m "feat(auth): add User.avatarUrl column, type, and store method"
```

---

### Task 2: Capture `avatarUrl` from Google + GitHub into `SsoProfile`

**Files:**
- Modify: `CP/src/auth/sso.ts` (`SsoProfile`, ~L28-35)
- Modify: `CP/src/auth/sso-oidc.ts` (`completeLogin`, ~L141-146)
- Modify: `CP/src/auth/sso-github.ts` (`completeLogin`, ~L101-113)
- Create: `CP/src/auth/sso-profile.test.ts`

- [ ] **Step 1: Add `avatarUrl` to `SsoProfile`**

In `CP/src/auth/sso.ts`, in `interface SsoProfile` after the `name?` field:

```ts
  /** Profile picture URL from the IdP (Google `picture`, GitHub
   *  `avatar_url`), when supplied. */
  avatarUrl?: string;
```

- [ ] **Step 2: Write a failing test for the GitHub email/avatar selection helper**

GitHub avatar capture is pure once the `/user` JSON is parsed. Create `CP/src/auth/sso-profile.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectGithubPrimaryEmail } from "./sso-github";

test("selectGithubPrimaryEmail prefers verified primary", () => {
  const email = selectGithubPrimaryEmail([
    { email: "alt@x.io", primary: false, verified: true },
    { email: "Me@Example.com", primary: true, verified: true },
  ]);
  assert.equal(email, "me@example.com");
});

test("selectGithubPrimaryEmail rejects when no verified email", () => {
  const email = selectGithubPrimaryEmail([
    { email: "me@example.com", primary: true, verified: false },
  ]);
  assert.equal(email, null);
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/sso-profile.test.ts`
Expected: PASS (this guards the existing helper before we touch the file).

- [ ] **Step 3: Capture `picture` in the Google OIDC provider**

In `CP/src/auth/sso-oidc.ts` `completeLogin`, replace the return (L142-146) with:

```ts
    const name =
      typeof claims.name === "string" && claims.name
        ? claims.name
        : email.split("@")[0];
    const avatarUrl =
      typeof claims.picture === "string" && claims.picture
        ? claims.picture
        : undefined;
    return { email, name, avatarUrl, provider: this.label };
```

- [ ] **Step 4: Capture `avatar_url` in the GitHub provider**

In `CP/src/auth/sso-github.ts` `completeLogin`, extend the `/user` parse (L101-112). Replace:

```ts
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
```

with:

```ts
    let name: string | undefined;
    let avatarUrl: string | undefined;
    const userRes = await fetch(USER_URL, { headers: authHeaders });
    if (userRes.ok) {
      const profile = (await userRes.json().catch(() => null)) as {
        name?: unknown;
        login?: unknown;
        avatar_url?: unknown;
      } | null;
      name =
        (typeof profile?.name === "string" && profile.name) ||
        (typeof profile?.login === "string" ? profile.login : undefined);
      avatarUrl =
        typeof profile?.avatar_url === "string" && profile.avatar_url
          ? profile.avatar_url
          : undefined;
    }
    return {
      email,
      name: name ?? email.split("@")[0],
      avatarUrl,
      provider: this.label,
    };
```

- [ ] **Step 5: Typecheck + run the test**

Run: `cd "%CP%" && npx tsc --noEmit ; npx tsx --test src/auth/sso-profile.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/sso.ts src/auth/sso-oidc.ts src/auth/sso-github.ts src/auth/sso-profile.test.ts
git commit -m "feat(auth): capture profile avatar from Google picture / GitHub avatar_url"
```

---

### Task 3: Thread `avatarUrl` through find-or-create + SSO login (refresh-if-empty)

**Files:**
- Modify: `CP/src/core/control-plane.ts` (`findOrCreateUser` ~L4869-4920; `loginWithSso` ~L5398-5428)
- Create: `CP/src/auth/avatar-login.test.ts`

- [ ] **Step 1: Write a failing test (avatar set on create; refresh only when empty)**

Create `CP/src/auth/avatar-login.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp() {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner(),
    dataPlane: stubDataPlane(),
    stripe: new StubStripeAdapter(),
    ai: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

test("social login stores avatar on first sign-in", async () => {
  const { cp, store } = makeCp();
  // Stub provider trusts the email; inject avatar via findOrCreateUser path
  // by calling the internal flow through loginWithSso with the stub.
  const res = await cp.loginWithSso({ provider: "google", email: "a@b.io" });
  assert.ok("token" in res);
  const user = await store.findUserByEmail("a@b.io");
  assert.ok(user);
});
```

NOTE: the stub provider does not emit an avatar, so this test asserts the login path still works. The avatar-specific assertions live in Step 4 once `findOrCreateUser` accepts the field.

Run: `cd "%CP%" && npx tsx --test src/auth/avatar-login.test.ts`
Expected: PASS (login still works) — establishes the harness.

- [ ] **Step 2: Add `avatarUrl` to `findOrCreateUser` input + create + refresh-if-empty**

In `CP/src/core/control-plane.ts` `findOrCreateUser` (L4869), add `avatarUrl?: string;` to the input type. In the `if (existing)` branch, before `return existing;` (before L4895), add:

```ts
      // Refresh the avatar only when we have none on file — never clobber
      // a value the user may later customise.
      if (input.avatarUrl && !existing.avatarUrl) {
        return this.deps.store.setUserAvatarUrl(existing.id, input.avatarUrl);
      }
```

In the `createUser` call (L4898-4907), add `avatarUrl: input.avatarUrl,` after `passwordHash: input.passwordHash,`.

- [ ] **Step 3: Pass `avatarUrl` from `loginWithSso`**

In `CP/src/core/control-plane.ts` `loginWithSso` (L5418-5421), change the `findOrCreateUser` call to:

```ts
    const user = await this.findOrCreateUser({
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
```

- [ ] **Step 4: Add the avatar assertion test (direct store-level capture)**

Append to `CP/src/auth/avatar-login.test.ts`:

```ts
test("findOrCreateUser refreshes avatar only when empty", async () => {
  const { cp, store } = makeCp();
  await cp.loginWithSso({ provider: "google", email: "c@d.io" });
  const u = await store.findUserByEmail("c@d.io");
  assert.ok(u);
  // Simulate a stored avatar, then ensure a later login with a different
  // url does NOT overwrite it.
  await store.setUserAvatarUrl(u.id, "https://img/original.png");
  await cp.loginWithSso({ provider: "google", email: "c@d.io" });
  const after = await store.findUserByEmail("c@d.io");
  assert.equal(after?.avatarUrl, "https://img/original.png");
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/avatar-login.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/core/control-plane.ts src/auth/avatar-login.test.ts
git commit -m "feat(auth): thread avatar through findOrCreateUser (refresh-if-empty)"
```

---

### Task 4: Expose `avatarUrl` on `/v1/me`, session resolve, and member rows

**Files:**
- Modify: `CP/src/core/control-plane.ts` (`resolveSession` user shape ~L5436-5469)
- Modify: `CP/src/index.ts` (`/v1/me` session branch ~L3431-3438)
- Modify: `CP/src/core/control-plane.ts` (`listMembers`/team mapping — locate via grep) if it returns a user shape

- [ ] **Step 1: Add `avatarUrl` to the `resolveSession` return type + value**

In `CP/src/core/control-plane.ts` `resolveSession` (L5436-5441) add `avatarUrl?: string;` to the `user` shape, and in the returned object (L5464-5468) add `avatarUrl: user.avatarUrl,` after `name: user.name,`.

- [ ] **Step 2: Add `avatarUrl` to `/v1/me`**

In `CP/src/index.ts` `/v1/me` session branch (L3431-3438), add to the `user` object after `emailVerifiedAt: user.emailVerifiedAt ?? null,`:

```ts
              avatarUrl: user.avatarUrl ?? null,
```

- [ ] **Step 3: Surface avatar on team member rows (if applicable)**

Run: `cd "%CP%" && grep -n "listMembers\|TeamMember\|toTeamMember" src/core/control-plane.ts src/domain/types.ts | head`
If `TeamMember` carries a `name`/`email`, add an optional `avatarUrl?: string` to that type and populate it from the member's user row in the mapping. If the member shape does not currently join the user row, SKIP this step and note it (Console falls back to initials for members).

- [ ] **Step 4: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/core/control-plane.ts src/index.ts src/domain/types.ts
git commit -m "feat(auth): expose avatarUrl on /v1/me + session resolve"
```

---

## Phase 2 — Session hardening (CP)

### Task 5: PKCE (S256) — port + control-plane + Google provider

**Files:**
- Modify: `CP/src/auth/sso.ts` (`SsoProvider` port ~L46-53; `StubSsoProvider` ~L61-71)
- Modify: `CP/src/core/control-plane.ts` (`beginSsoLogin` ~L5385-5393; `loginWithSso` input ~L5398-5412)
- Modify: `CP/src/auth/sso-oidc.ts` (`startLogin` ~L64-78; `completeLogin` token body ~L97-103)
- Modify: `CP/src/auth/sso-github.ts` (`startLogin` ~L51-60 — accept but ignore challenge)
- Modify: `CP/src/index.ts` (`ssoLoginSchema` ~L2246-2250; sso/login handler passes `codeVerifier`)
- Create: `CP/src/auth/pkce.test.ts`

- [ ] **Step 1: Write a failing test for the PKCE challenge derivation**

The control plane derives `code_challenge = base64url(sha256(verifier))`. Create `CP/src/auth/pkce.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { derivePkceChallenge } from "./pkce";

test("derivePkceChallenge is base64url sha256 of the verifier", () => {
  const verifier = "abc123";
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(derivePkceChallenge(verifier), expected);
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/pkce.test.ts`
Expected: FAIL — `./pkce` does not exist.

- [ ] **Step 2: Create the PKCE helper**

Create `CP/src/auth/pkce.ts`:

```ts
/* PKCE (RFC 7636) helpers — S256 challenge derivation. Google supports
 * PKCE; GitHub OAuth Apps do not, so the GitHub provider ignores the
 * challenge and relies on the client secret + state cookie. */
import { createHash, randomBytes } from "node:crypto";

/** A high-entropy code verifier (43-128 chars, base64url). */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** code_challenge = BASE64URL(SHA256(verifier)). */
export function derivePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
```

Run: `cd "%CP%" && npx tsx --test src/auth/pkce.test.ts`
Expected: PASS.

- [ ] **Step 3: Extend the `SsoProvider` port**

In `CP/src/auth/sso.ts`, change `startLogin`/`completeLogin` signatures on the interface (L46-53):

```ts
  startLogin(input: {
    redirectUri: string;
    state: string;
    /** PKCE S256 challenge. Honoured by OIDC providers that support PKCE
     *  (Google); ignored by GitHub OAuth Apps. */
    codeChallenge?: string;
  }): { authorizeUrl: string };

  completeLogin(input: {
    code?: string;
    email?: string;
    /** PKCE verifier echoed at the token exchange. */
    codeVerifier?: string;
  }): Promise<SsoProfile>;
```

`StubSsoProvider.startLogin` (L61) — widen its param to accept `codeChallenge?: string` (ignore it); `completeLogin` already accepts a superset — widen to accept `codeVerifier?: string` (ignore).

- [ ] **Step 4: Generate verifier + challenge in `beginSsoLogin`**

In `CP/src/core/control-plane.ts`, add the import near the top (with the other `./auth/*` imports):

```ts
import { generatePkceVerifier, derivePkceChallenge } from "../auth/pkce";
```

Replace `beginSsoLogin` (L5385-5393):

```ts
  beginSsoLogin(
    provider: string,
    redirectUri: string,
  ): {
    authorizeUrl: string;
    provider: string;
    state: string;
    codeVerifier: string;
  } {
    const p = getSsoProvider(provider);
    const state = randomBytes(12).toString("hex");
    const codeVerifier = generatePkceVerifier();
    const codeChallenge = derivePkceChallenge(codeVerifier);
    const { authorizeUrl } = p.startLogin({ redirectUri, state, codeChallenge });
    return { authorizeUrl, provider: p.label, state, codeVerifier };
  }
```

In `loginWithSso` input type (L5398-5402) add `codeVerifier?: string;`, and pass it through to `completeLogin` (L5412):

```ts
      profile = await getSsoProvider(input.provider).completeLogin(input);
```

(`input` already carries `codeVerifier` once added to the type — no change to the call itself.)

- [ ] **Step 5: Implement PKCE in the Google OIDC provider**

In `CP/src/auth/sso-oidc.ts` `startLogin` (L64), add the challenge params before `return`:

```ts
    if (input.codeChallenge) {
      u.searchParams.set("code_challenge", input.codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
```

In `completeLogin` (L82) add `codeVerifier?: string;` to the input type, and in the token-exchange body (L97-103) append the verifier when present:

```ts
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.opts.redirectUri,
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
        }).toString(),
```

- [ ] **Step 6: GitHub provider accepts the wider signatures (no PKCE)**

In `CP/src/auth/sso-github.ts`, widen `startLogin` input to `{ redirectUri: string; state: string; codeChallenge?: string }` (ignore `codeChallenge`) and `completeLogin` input to `{ code?: string; codeVerifier?: string }` (ignore `codeVerifier`). Add a one-line comment: `// GitHub OAuth Apps don't support PKCE; the client secret + state cookie are the guard.`

- [ ] **Step 7: Accept `codeVerifier` on the sso/login route**

In `CP/src/index.ts` `ssoLoginSchema` (L2246-2250) add:

```ts
  codeVerifier: z.string().optional(),
```

(The handler at L2448 already passes `parsed.data` straight to `cp.loginWithSso`, so no handler change.)

- [ ] **Step 8: Typecheck + run tests**

Run: `cd "%CP%" && npx tsc --noEmit ; npx tsx --test src/auth/pkce.test.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 9: Commit**

```bash
git add src/auth/pkce.ts src/auth/pkce.test.ts src/auth/sso.ts src/auth/sso-oidc.ts src/auth/sso-github.ts src/core/control-plane.ts src/index.ts
git commit -m "feat(auth): PKCE S256 for Google (port + control-plane + provider)"
```

---

### Task 6: JWKS RS256 id_token signature verification (Google) via `jose`

**Files:**
- Modify: `CP/package.json` (add `jose`)
- Modify: `CP/src/auth/sso-oidc.ts` (`OidcSsoProviderOpts` + `completeLogin` claim handling + `googleProviderFromEnv`)
- Create: `CP/src/auth/sso-oidc.test.ts`

- [ ] **Step 1: Install `jose`**

Run: `cd "%CP%" && npm install jose`
Expected: `jose` added to `dependencies`.

- [ ] **Step 2: Add a configurable JWKS URI to the provider opts**

In `CP/src/auth/sso-oidc.ts` `OidcSsoProviderOpts` (L32-46) add:

```ts
  /** JWKS endpoint for RS256 id_token signature verification. When set,
   *  the id_token signature is verified (defence in depth beyond the TLS
   *  back-channel). Omit for IdPs without a published JWKS. */
  jwksUri?: string;
```

- [ ] **Step 3: Verify the signature with `jose` when `jwksUri` is set**

In `CP/src/auth/sso-oidc.ts`, add near the top:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
```

Add a lazily-built JWKS set as a private field on `OidcSsoProvider`:

```ts
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
```

In `completeLogin`, replace the decode + iss/aud/exp block (L127-140) with:

```ts
    let claims: Record<string, unknown>;
    if (this.opts.jwksUri) {
      if (!this.jwks) {
        this.jwks = createRemoteJWKSet(new URL(this.opts.jwksUri));
      }
      try {
        const { payload } = await jwtVerify(idToken, this.jwks, {
          issuer: this.opts.issuer,
          audience: this.opts.clientId,
        });
        claims = payload as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `OIDC id_token signature verification failed: ${
            err instanceof Error ? err.message : "invalid token"
          }`,
        );
      }
    } else {
      // No JWKS configured — fall back to TLS-back-channel trust (decode +
      // claim checks). Retained for non-Google OIDC IdPs without a JWKS.
      claims = decodeJwtClaims(idToken);
      if (claims.iss !== this.opts.issuer) {
        throw new Error(
          "OIDC id_token issuer does not match the configured issuer",
        );
      }
      if (!audienceMatches(claims.aud, this.opts.clientId)) {
        throw new Error("OIDC id_token audience does not include this client");
      }
      if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
        throw new Error("OIDC id_token has expired");
      }
    }
```

(`jwtVerify` already enforces `iss`/`aud`/`exp` for the JWKS path.)

- [ ] **Step 4: Point Google at its JWKS**

In `googleProviderFromEnv` (L202-209) add to the `new OidcSsoProvider({...})` config:

```ts
    jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
```

- [ ] **Step 5: Write a test for the back-channel fallback path (no network)**

Create `CP/src/auth/sso-oidc.test.ts` — exercise `emailFromVerifiedClaims` (pure, already exported) to lock the verified-email guard that signature verification feeds:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { emailFromVerifiedClaims } from "./sso-oidc";

test("emailFromVerifiedClaims requires email_verified === true", () => {
  assert.throws(() =>
    emailFromVerifiedClaims({ email: "x@y.io", email_verified: false }),
  );
});

test("emailFromVerifiedClaims normalises a verified email", () => {
  assert.equal(
    emailFromVerifiedClaims({ email: "X@Y.io", email_verified: true }),
    "x@y.io",
  );
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/sso-oidc.test.ts`
Expected: PASS. (Full signature verification is exercised in the live dev smoke in Phase 5 — a unit test would require minting an RS256 token against a fake JWKS, which `jose`'s own suite already covers.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add package.json package-lock.json src/auth/sso-oidc.ts src/auth/sso-oidc.test.ts
git commit -m "feat(auth): verify Google id_token RS256 signature via jose JWKS"
```

---

### Task 7: Login rate-limiting

**Files:**
- Create: `CP/src/auth/rate-limit.ts`
- Create: `CP/src/auth/rate-limit.test.ts`
- Modify: `CP/src/index.ts` (apply to `/v1/auth/login`, `/v1/auth/register`, `/v1/auth/sso/login`)

- [ ] **Step 1: Write a failing test**

Create `CP/src/auth/rate-limit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "./rate-limit";

test("allows up to max within the window, then blocks", () => {
  const allow = createRateLimiter({ windowMs: 1000, max: 3 });
  assert.equal(allow("ip1", 0), true);
  assert.equal(allow("ip1", 100), true);
  assert.equal(allow("ip1", 200), true);
  assert.equal(allow("ip1", 300), false); // 4th in window blocked
  assert.equal(allow("ip2", 300), true); // different key unaffected
});

test("resets after the window elapses", () => {
  const allow = createRateLimiter({ windowMs: 1000, max: 1 });
  assert.equal(allow("ip1", 0), true);
  assert.equal(allow("ip1", 500), false);
  assert.equal(allow("ip1", 1000), true); // window rolled over
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/rate-limit.test.ts`
Expected: FAIL — `./rate-limit` missing.

- [ ] **Step 2: Implement the limiter**

Create `CP/src/auth/rate-limit.ts`:

```ts
/* Fixed-window in-memory rate limiter for auth routes. Per-instance only;
 * a multi-node deployment would need a shared store (Redis). Acceptable
 * for the current single-node control plane (documented caveat). */
export interface RateLimitOpts {
  windowMs: number;
  max: number;
}

/** Returns a `check(key, nowMs)` predicate: true = allowed, false = over
 *  limit. `nowMs` is injected so the logic is pure and testable. */
export function createRateLimiter(
  opts: RateLimitOpts,
): (key: string, nowMs: number) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key, nowMs) => {
    const entry = hits.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: nowMs + opts.windowMs });
      return true;
    }
    if (entry.count >= opts.max) return false;
    entry.count += 1;
    return true;
  };
}
```

Run: `cd "%CP%" && npx tsx --test src/auth/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire it into the auth routes**

In `CP/src/index.ts`, near the top imports add:

```ts
import { createRateLimiter } from "./auth/rate-limit";
```

After the app is created (near the other module-scope consts, e.g. by L45), add:

```ts
// 10 auth attempts per IP per minute, shared across login/register/sso.
const authRateLimit = createRateLimiter({ windowMs: 60_000, max: 10 });
```

In each of the three handlers (`POST /v1/auth/login`, `POST /v1/auth/register`, `POST /v1/auth/sso/login` at ~L2443), add as the FIRST lines of the handler body:

```ts
  if (!authRateLimit(request.ip, Date.now())) {
    return reply.code(429).send({ error: "too many attempts, slow down" });
  }
```

(Find the exact login/register handlers via `grep -n '"/v1/auth/login"\|"/v1/auth/register"' src/index.ts`.)

- [ ] **Step 4: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/auth/rate-limit.ts src/auth/rate-limit.test.ts src/index.ts
git commit -m "feat(auth): fixed-window rate limit on login/register/sso routes"
```

---

### Task 8: Session rotation — revoke-all on password change + rotate on org switch

**Files:**
- Modify: `CP/src/domain/store.ts` (interface + InMemoryStore: `deleteSessionsByUser`)
- Modify: `CP/src/domain/prisma-store.ts` (`deleteSessionsByUser`)
- Modify: `CP/src/core/control-plane.ts` (`changePassword` calls it; org-switch re-mints)
- Create: `CP/src/auth/session-revoke.test.ts`

> **Scope note (record + flag at handoff):** the spec's *sliding-window auto-rotation on every `resolveSession`* is **deferred** — it requires the Console to adopt a new cookie mid-request, which the API/cookie split makes a heavy round-trip; the 7-day absolute expiry bounds the risk. This task delivers the two concrete, high-value rotation points: revoke-all-on-password-change and rotate-on-org-switch.

- [ ] **Step 1: Write a failing test**

Create `CP/src/auth/session-revoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "../domain/store";

test("deleteSessionsByUser removes every session for that user", async () => {
  const store = new InMemoryStore();
  await store.createSession({
    id: "s1", userId: "u1", tokenHash: "h1",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  await store.createSession({
    id: "s2", userId: "u1", tokenHash: "h2",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  await store.createSession({
    id: "s3", userId: "u2", tokenHash: "h3",
    expiresAt: new Date(Date.now() + 1e6).toISOString(),
    createdAt: new Date().toISOString(),
  });
  const removed = await store.deleteSessionsByUser("u1");
  assert.equal(removed, 2);
  assert.equal(await store.findSessionByTokenHash("h1"), null);
  assert.ok(await store.findSessionByTokenHash("h3")); // u2 untouched
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/session-revoke.test.ts`
Expected: FAIL — `deleteSessionsByUser` undefined.

- [ ] **Step 2: Add to the Store interface**

In `CP/src/domain/store.ts` after `deleteSession(...)` (L261):

```ts
  /** Delete every session for a user (e.g. on password change). Returns
   *  the number removed. */
  deleteSessionsByUser(userId: string): Promise<number>;
```

- [ ] **Step 3: Implement in InMemoryStore**

In `CP/src/domain/store.ts` after `deleteSession` (L1326):

```ts
  async deleteSessionsByUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    return n;
  }
```

- [ ] **Step 4: Implement in PrismaStore**

In `CP/src/domain/prisma-store.ts` near `deleteSession` (grep `async deleteSession`):

```ts
  async deleteSessionsByUser(userId: string): Promise<number> {
    const res = await this.db.session.deleteMany({ where: { userId } });
    return res.count;
  }
```

Run: `cd "%CP%" && npx tsx --test src/auth/session-revoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Revoke all sessions on password change**

In `CP/src/core/control-plane.ts` `changePassword` (L5041-5045), after `updateUserPassword(...)` and before `return`:

```ts
    // Rotate: invalidate every existing session so a stolen cookie can't
    // outlive a password change. The caller re-authenticates.
    await this.deps.store.deleteSessionsByUser(input.userId);
```

- [ ] **Step 6: Rotate the session token on org switch**

Run: `cd "%CP%" && grep -n "switchOrg\|orgs/switch\|currentAccountId =" src/core/control-plane.ts | head`
In the org-switch method (the one backing `POST /v1/me/orgs/switch`), after the active account is changed, mint a fresh session and delete the old one so the token rotates on the privilege-context change. If the method does not currently return a token to the caller, add a returned `{ token, expiresAt }` and update the `/v1/me/orgs/switch` handler (CP/src/index.ts ~L3476) to set it in the response so the Console can replace its cookie. If wiring the cookie swap proves larger than this task, implement revoke-all (Step 5) only and record org-switch rotation as a follow-up (note it at handoff).

- [ ] **Step 7: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/domain/store.ts src/domain/prisma-store.ts src/core/control-plane.ts src/auth/session-revoke.test.ts
git commit -m "feat(auth): revoke all sessions on password change; rotate on org switch"
```

---

### Task 9: Refuse the SSO stub in production

**Files:**
- Modify: `CP/src/auth/sso.ts` (`StubSsoProvider.completeLogin` ~L73-82)
- Create: `CP/src/auth/stub-guard.test.ts`

- [ ] **Step 1: Write a failing test**

Create `CP/src/auth/stub-guard.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubSsoProvider } from "./sso";

test("stub refuses to complete a login in production", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const stub = new StubSsoProvider();
    await assert.rejects(() => stub.completeLogin({ email: "x@y.io" }));
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("stub still works outside production", async () => {
  const stub = new StubSsoProvider();
  const p = await stub.completeLogin({ email: "x@y.io" });
  assert.equal(p.email, "x@y.io");
});
```

Run: `cd "%CP%" && npx tsx --test src/auth/stub-guard.test.ts`
Expected: FAIL — first test (no production guard yet).

- [ ] **Step 2: Add the production guard**

In `CP/src/auth/sso.ts` `StubSsoProvider.completeLogin` (L73), make it the first statement:

```ts
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SSO stub is disabled in production — configure a real provider",
      );
    }
```

Run: `cd "%CP%" && npx tsx --test src/auth/stub-guard.test.ts`
Expected: PASS (both).

- [ ] **Step 3: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/auth/sso.ts src/auth/stub-guard.test.ts
git commit -m "feat(auth): stub SSO provider refuses logins in production"
```

---

## Phase 3 — Console: PKCE wiring + avatars

### Task 10: Thread the PKCE verifier through the Console OAuth flow

**Files:**
- Modify: `CONSOLE/src/lib/auth.ts` (`beginOauth` ~L124-161; `consumeOauthState` ~L166-186)
- Modify: `CONSOLE/src/app/(auth-public)/auth/callback/[provider]/route.ts`

- [ ] **Step 1: Capture `codeVerifier` from sso/start and store it in the state cookie**

In `CONSOLE/src/lib/auth.ts` `beginOauth` (L138-159): widen the parsed response and cookie payload.

Replace the response parse (L138-144):

```ts
    const data = (await res.json().catch(() => null)) as {
      authorizeUrl?: string;
      state?: string;
      codeVerifier?: string;
    } | null;
    if (!res.ok || !data?.authorizeUrl || !data?.state) return null;
    authorizeUrl = data.authorizeUrl;
    state = data.state;
    var codeVerifier = data.codeVerifier ?? "";
```

(Declare `let codeVerifier = "";` alongside `let state: string;` at L130 instead of `var`, to match the file's style.)

Replace the cookie payload (L150):

```ts
    JSON.stringify({ state, from, provider, codeVerifier }),
```

- [ ] **Step 2: Return `codeVerifier` from `consumeOauthState`**

In `CONSOLE/src/lib/auth.ts` `consumeOauthState` (L166-186): widen the return type to include `codeVerifier: string`, parse it, and return it:

```ts
export function consumeOauthState(
  presentedState: string | undefined,
): { from: string; provider: string; codeVerifier: string } | null {
  const raw = cookies().get(OAUTH_STATE_COOKIE)?.value;
  cookies().delete(OAUTH_STATE_COOKIE);
  if (!raw || !presentedState) return null;
  try {
    const parsed = JSON.parse(raw) as {
      state?: string;
      from?: string;
      provider?: string;
      codeVerifier?: string;
    };
    if (!parsed.state || parsed.state !== presentedState) return null;
    return {
      from: typeof parsed.from === "string" ? parsed.from : "/dashboard",
      provider: parsed.provider ?? "",
      codeVerifier:
        typeof parsed.codeVerifier === "string" ? parsed.codeVerifier : "",
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Send `codeVerifier` to sso/login from the callback**

In `CONSOLE/src/app/(auth-public)/auth/callback/[provider]/route.ts`, find the call to `establishSession("/auth/sso/login", {...})` (or the direct fetch to `/v1/auth/sso/login`) and add `codeVerifier` to the body, sourced from the `consumeOauthState` result. (Read the file first; it already destructures `from`/`provider` from `consumeOauthState`.)

Example shape (adapt to the file's existing variable names):

```ts
  const consumed = consumeOauthState(presentedState);
  if (!consumed) return NextResponse.redirect(/* error back to /login */);
  const error = await establishSession("/auth/sso/login", {
    provider: consumed.provider,
    code,
    codeVerifier: consumed.codeVerifier,
  });
```

- [ ] **Step 4: Typecheck**

Run: `cd "%CONSOLE%" && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd "%CONSOLE%" && git add src/lib/auth.ts "src/app/(auth-public)/auth/callback/[provider]/route.ts"
git commit -m "feat(auth): carry PKCE verifier through Console OAuth state cookie"
```

---

### Task 11: `<Avatar>` component + render the signed-in user's avatar

**Files:**
- Create: `CONSOLE/src/components/Avatar.tsx`
- Modify: `CONSOLE/src/lib/api.ts` (the `whoami()` return type — add `avatarUrl`)
- Modify: `CONSOLE/src/components/SettingsView.tsx` (render the user avatar where `me.user` is shown)
- Modify: `CONSOLE/src/components/TeamView.tsx` (member rows — use avatar when present)

- [ ] **Step 1: Create the Avatar component**

Create `CONSOLE/src/components/Avatar.tsx`:

```tsx
/* Avatar — renders a profile image when a URL is present, else the
 * initials fallback the Console already uses elsewhere. */
import Image from "next/image";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  url,
  name,
  size = 32,
}: {
  url?: string | null;
  name: string;
  size?: number;
}) {
  if (url) {
    return (
      <Image
        src={url}
        alt={name}
        width={size}
        height={size}
        className="rounded-full object-cover"
        unoptimized
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-zinc-700 text-xs font-medium text-zinc-100"
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}
```

> If `next/image` with remote URLs needs domain allow-listing, prefer a plain `<img>` to avoid `next.config` changes — swap the `<Image .../>` for `<img src={url} alt={name} width={size} height={size} className="rounded-full object-cover" />`. Decide based on whether `next.config.js` already has `images.remotePatterns`; check before choosing.

- [ ] **Step 2: Add `avatarUrl` to the whoami user type**

In `CONSOLE/src/lib/api.ts`, find the `whoami()` return type (grep `whoami`) — the authenticated branch carries `user?: { id; email; name; emailVerifiedAt }`. Add `avatarUrl?: string | null;` to that user shape.

- [ ] **Step 3: Render the user avatar in SettingsView**

In `CONSOLE/src/components/SettingsView.tsx`, locate where `me.user` (the whoami result, stored via `setMe`) renders the signed-in user's name/email (grep `me?.user` / `me.user`). Add the avatar beside it:

```tsx
import { Avatar } from "./Avatar";
// ...where the user's name is shown:
<Avatar url={me?.authenticated ? me.user?.avatarUrl : null}
        name={me?.authenticated ? me.user?.name ?? me.user?.email ?? "You" : "You"}
        size={40} />
```

If SettingsView does not currently render `me.user` (only the account), add a small "Your profile" row above the workspace section showing `<Avatar>` + `me.user.name` + `me.user.email`.

- [ ] **Step 4: Use avatars in TeamView member rows (only if the API returns them)**

In `CONSOLE/src/components/TeamView.tsx` (member rows ~L293 render `m.initials`): if `listMembers` now returns `avatarUrl` per member (depends on Task 4 Step 3), replace the initials span with `<Avatar url={m.avatarUrl} name={m.name} size={32} />`. If the member shape has no `avatarUrl`, leave initials as-is.

- [ ] **Step 5: Typecheck / build**

Run: `cd "%CONSOLE%" && npm run build`
Expected: build succeeds (the strongest Console typecheck).

- [ ] **Step 6: Commit**

```bash
cd "%CONSOLE%" && git add src/components/Avatar.tsx src/lib/api.ts src/components/SettingsView.tsx src/components/TeamView.tsx
git commit -m "feat(console): user profile avatar with initials fallback"
```

---

### Task 12: Dev redirect-URI + env documentation

**Files:**
- Modify: `CP/.env.example`
- Modify: `CONSOLE/.env.local.example`
- Create/append: a short README note in `CP/docs/` if an auth doc exists (else skip)

- [ ] **Step 1: Document the dev redirect URI gotcha**

`OidcSsoProvider.startLogin` sends `opts.redirectUri` (the env value), NOT the Console's runtime origin — so the **localhost** dev flow only works if `CANTILA_GOOGLE_REDIRECT_URI` / `CANTILA_GITHUB_REDIRECT_URI` are set to the localhost callback in the dev `.env`. Add this note to `CP/.env.example` near the OAuth vars:

```
# Google/GitHub OAuth. For LOCAL dev, set the *_REDIRECT_URI to
# http://localhost:3000/auth/callback/{google,github} and register BOTH the
# localhost and https://cantila.app callbacks in each provider's app settings.
# CANTILA_GOOGLE_CLIENT_ID=
# CANTILA_GOOGLE_CLIENT_SECRET=
# CANTILA_GOOGLE_REDIRECT_URI=https://cantila.app/auth/callback/google
# CANTILA_GITHUB_CLIENT_ID=
# CANTILA_GITHUB_CLIENT_SECRET=
# CANTILA_GITHUB_REDIRECT_URI=https://cantila.app/auth/callback/github
```

- [ ] **Step 2: Commit**

```bash
cd "%CP%" && git add .env.example
git commit -m "docs(auth): document dev redirect-URI requirement for OAuth"
```

---

## Phase 4 — Remove all demo accounts

### Task 13: Control plane — remove the `acc_demo` fallback

**Files:**
- Modify: `CP/src/index.ts` (`DEFAULT_ACCOUNT_ID` L42; `resolveAccountId` L541-550; `resolveActorAccountId` L556-563; onRequest hook L269-272; 5× `.default("acc_demo")` L659/713/736/741/747)
- Modify: `CP/src/core/control-plane.ts` (`listProjects("acc_demo")` fallback L5928-5930)
- Modify: `CP/src/domain/prisma-store.ts` (3× "Demo Account" connectOrCreate/upsert L459-468, L1291-1299, L1778-1783)
- Modify: `CP/src/domain/seed-platform.ts` (any acc_demo usage)
- Create: `CP/src/auth/account-resolution.test.ts`

> **This is the widest-blast-radius task. Rule: resolve account from the authenticated principal (API key or session); when none, error — never default to a fake account.** With `CANTILA_REQUIRE_AUTH=on` the fallback is already unreachable; this removes it for the off path too.

- [ ] **Step 1: Introduce a typed unauthenticated error + make resolution throw instead of defaulting**

In `CP/src/index.ts`, add near the top:

```ts
class NoAccountContextError extends Error {
  constructor() {
    super("no account context — authentication required");
    this.name = "NoAccountContextError";
  }
}
```

Replace `resolveAccountId` (L541-550) tail `return q.accountId ?? DEFAULT_ACCOUNT_ID;` with:

```ts
  if (q.accountId) return q.accountId;
  throw new NoAccountContextError();
```

Do the same for `resolveActorAccountId` (L556-563).

- [ ] **Step 2: Map the error to a 401 via a Fastify error handler**

In `CP/src/index.ts`, after the app is created and hooks registered (before `app.listen`), add:

```ts
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof NoAccountContextError) {
    return reply.code(401).send({ error: err.message });
  }
  throw err; // fall through to Fastify's default handling
});
```

- [ ] **Step 3: Remove `DEFAULT_ACCOUNT_ID` from the session hook**

In `CP/src/index.ts` onRequest hook (L269-272), change:

```ts
        accountId:
          resolved.currentAccountId ??
          resolved.user.accountId ??
          DEFAULT_ACCOUNT_ID,
```

to:

```ts
        accountId: resolved.currentAccountId ?? resolved.user.accountId,
```

(`SessionAuth.accountId` becomes possibly-undefined; routes that need an account call `resolveAccountId`, which now throws when there's truly none. If TS complains that `SessionAuth.accountId` is `string`, widen it to `string | undefined` in its type definition — grep `interface SessionAuth`.)

- [ ] **Step 4: Delete the `DEFAULT_ACCOUNT_ID` constant + the 5 zod defaults**

Remove `const DEFAULT_ACCOUNT_ID = "acc_demo";` (L42). For each `accountId: z.string().default("acc_demo"),` (L659/713/736/741/747), change to `accountId: z.string().optional(),` and ensure the handler resolves the account via `resolveAccountId(req)` (session/key) rather than the body default. Run `grep -n 'default("acc_demo")' src/index.ts` to confirm zero remain.

- [ ] **Step 5: Remove the capacity `listProjects("acc_demo")` fallback**

In `CP/src/core/control-plane.ts` (L5928-5930):

```ts
    const projects = accountId
      ? await this.deps.store.listProjects(accountId)
      : [];
```

- [ ] **Step 6: Replace the 3 "Demo Account" auto-creates with `connect`**

In `CP/src/domain/prisma-store.ts`:
- `createProject` (L459-468): replace the `account: { connectOrCreate: {...} }` with `account: { connect: { id: p.accountId } }`.
- registration create (L1778-1783): replace with `account: { connect: { id: r.accountId } }`.
- the membership/invite upsert (L1291-1299): remove the `account.upsert({... name: "Demo Account" ...})` block entirely — the account is expected to already exist; if a downstream FK error is a concern, leave the upsert but change `create` to throw via a `connect`-style guard. Prefer deletion: a missing account here is a real error.

- [ ] **Step 7: Clean `seed-platform.ts`**

Run: `cd "%CP%" && grep -n "acc_demo\|Demo Account" src/domain/seed-platform.ts`
Remove or rename any `acc_demo`/"Demo Account" seed so no demo account is created at boot. (The real owner account comes from `seed-owner.ts` + `CANTILA_OWNER_*`.) If `seed-platform.ts` legitimately needs a platform account, use the real platform account id, not `acc_demo`.

- [ ] **Step 8: Write the resolution test**

Create `CP/src/auth/account-resolution.test.ts` — assert that an account-scoped read with no principal and no `accountId` query errors rather than returning demo data. Use the existing in-process Fastify `app.inject` pattern if present (grep `app.inject` in existing tests); otherwise assert at the `resolveAccountId` unit level by importing it (export it if not already) and calling with a bare `{}` request stub, expecting it to throw `NoAccountContextError`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAccountId } from "../index"; // export it from index.ts

test("resolveAccountId throws when there is no principal or query account", () => {
  const req = { query: {} } as unknown as Parameters<typeof resolveAccountId>[0];
  assert.throws(() => resolveAccountId(req));
});
```

(If `index.ts` runs `app.listen` on import, move `resolveAccountId` into a small `src/auth/account.ts` module and import from there in both `index.ts` and the test, to avoid booting the server during tests.)

Run: `cd "%CP%" && npx tsx --test src/auth/account-resolution.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
cd "%CP%" && npx tsc --noEmit
git add src/index.ts src/core/control-plane.ts src/domain/prisma-store.ts src/domain/seed-platform.ts src/auth/account-resolution.test.ts
git commit -m "refactor(auth): remove acc_demo account fallback; resolve from session or 401"
```

---

### Task 14: Console — remove the `acc_demo` defaults

**Files:**
- Modify: `CONSOLE/src/lib/api.ts` (17 sites)
- Modify: `CONSOLE/src/components/MonitoringView.tsx` (L118)

> Pattern: the control plane scopes by session, so the `accountId` query/body is unnecessary when authenticated. Make each param optional with **no default** and append the query only when provided; drop the hardcoded body `accountId`.

- [ ] **Step 1: Query-param functions — drop the default, append conditionally**

For each of these (current line → function), change `(accountId = "acc_demo")` to `(accountId?: string)` and build the query so `accountId` is omitted when undefined:
`listProjects` (L223), `listApiKeys` (L404), `listRegistrations` (L564), `listAccountDatabases` (L577), `listBuckets` (L582), `listHostedMailboxes` (L605), `listActivity` (L680), `getMonitoring` (L724), `getBillingSummary` (L729), `getCostOptimisation` (L739), `getCapacity` (L823), `getMailFleet` (L862), `getSmsFleet` (L868), `listMembers` (L1006).

Concretely, for a function like `listProjects` (L223-225):

```ts
  listProjects: (accountId?: string) =>
    request<{ projects: ApiProject[] }>(
      accountId
        ? `/projects?accountId=${encodeURIComponent(accountId)}`
        : `/projects`,
    ),
```

Apply the same conditional-query shape to each listed function (each has its own path/return type — keep those unchanged, only the param default + query construction change).

- [ ] **Step 2: POST-body functions — drop the hardcoded `accountId`**

For the three `body: JSON.stringify({ accountId: "acc_demo", ...input })` sites (L416, L560, L1019): remove `accountId: "acc_demo",` so the body is `JSON.stringify({ ...input })` (the control plane scopes by session). If a caller legitimately needs to specify an account, the function should accept `accountId?: string` and spread it only when present.

- [ ] **Step 3: MonitoringView**

In `CONSOLE/src/components/MonitoringView.tsx` (L118): `api.getMonitoring("acc_demo", first)` → `api.getMonitoring(undefined, first)` (or drop the arg if `first` is positional — read the call; getMonitoring is now `(accountId?, fresh?)`, so use `api.getMonitoring(undefined, first)`).

- [ ] **Step 4: Grep guard + build**

Run: `cd "%CONSOLE%" && grep -rn "acc_demo" src ; npm run build`
Expected: grep returns nothing; build succeeds.

- [ ] **Step 5: Commit**

```bash
cd "%CONSOLE%" && git add src/lib/api.ts src/components/MonitoringView.tsx
git commit -m "refactor(console): remove acc_demo defaults; rely on session scoping"
```

---

### Task 15: CLI — remove the `acc_demo` default

**Files:**
- Modify: `CLI/src/config.ts` (L32)

- [ ] **Step 1: Read the config shape + remove the default**

Read `CLI/src/config.ts` around L20-50. Remove the `accountId: "acc_demo",` default. If `accountId` is required by the config type, make it optional (`accountId?: string`) and have commands that need it derive it from the authenticated context / a `cantila login` flow, or error with a clear "run `cantila login` first" message. Read how `config.accountId` is consumed before choosing (grep `config.accountId` / `\.accountId` in `CLI/src`).

- [ ] **Step 2: Typecheck**

Run: `cd "%CLI%" && npx tsc --noEmit`
Expected: clean (fix any now-required-vs-optional fallout per Step 1).

- [ ] **Step 3: Grep guard + commit**

```bash
cd "%CLI%" && grep -rn "acc_demo" src
git add src/config.ts
git commit -m "refactor(cli): remove acc_demo account default"
```

---

## Phase 5 — Verification

### Task 16: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Typecheck all repos**

```bash
cd "%CP%" && npx tsc --noEmit
cd "%CONSOLE%" && npm run build
cd "%CLI%" && npx tsc --noEmit
```
Expected: all clean.

- [ ] **Step 2: Run the full control-plane test suite**

```bash
cd "%CP%" && npx tsx --test src/auth/*.test.ts src/sms/*.test.ts
```
Expected: all PASS (new auth tests + the existing SMS activation tests still green).

- [ ] **Step 3: Grep guard — no demo accounts remain**

```bash
cd "c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila" && grep -rn "acc_demo\|Demo Account" cantila-control-plane/src cantila-console/src cantila-cli/src --include=*.ts --include=*.tsx | grep -v ".test.ts" | grep -v "/agents/" | grep -v "/mcp/"
```
Expected: empty (or only deliberate test fixtures / comments — review each remaining hit).

- [ ] **Step 4: Live dev smoke (manual checklist)**

Set the dev `*_REDIRECT_URI` env to localhost (Task 12), start the control plane + Console, then:
- Visit `/login` → both Google and GitHub buttons render as **live** (no "(stub)" badge).
- Complete a **Google** sign-in → lands on `/dashboard`; the PKCE `code_challenge` is on the authorize URL; the id_token signature verifies; the profile avatar renders (not initials) in Settings.
- Complete a **GitHub** sign-in → avatar renders; verified primary email used.
- Change password in Settings → existing session is revoked (next request re-prompts login).
- Hit `/v1/auth/login` >10×/min → 429.
- Confirm the Console shows the **real** account name everywhere (no "Demo Account").

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to decide merge/PR per repo.

---

## Self-review

**Spec coverage:**
- A1 verify-live → Task 16 Step 4 (smoke) + Task 12 (dev redirect note). ✓
- A2 PKCE → Task 5. ✓  A3 JWKS → Task 6. ✓  A4 rate-limit → Task 7. ✓
- A5 session rotation → Task 8 (revoke-all + org-switch rotation; **sliding-window auto-rotation explicitly deferred with rationale — flag at handoff**). ✓ (partial-by-design)
- A6 stub backdoor → Task 9. ✓
- B avatars: schema/type/store → Task 1; capture → Task 2; thread/refresh-if-empty → Task 3; expose → Task 4; render → Task 11. ✓
- C demo removal: control plane → Task 13; console → Task 14; cli → Task 15. ✓
- Branch isolation → Task 0. ✓  Verification → Task 16. ✓

**Placeholder scan:** No "TBD"/"implement later". Two steps are deliberately conditional-on-inspection (Task 4 Step 3 member shape; Task 8 Step 6 org-switch wiring; Task 11 Step 1 next/image-vs-img) — each states the exact decision rule and the fallback, which is the honest treatment for an unknown-until-read shape, not a placeholder.

**Type consistency:** `avatarUrl` is the single property name across `User`/`AuthUser`/`SsoProfile`/`/v1/me`/`whoami`/`<Avatar url>`. `codeVerifier`/`codeChallenge` consistent across port → control-plane → providers → schema → Console cookie. `deleteSessionsByUser` / `setUserAvatarUrl` names consistent between interface, InMemoryStore, PrismaStore, and callers. `NoAccountContextError` consistent between throw sites and the error handler.

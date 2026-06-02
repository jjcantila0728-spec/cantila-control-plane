# MCP OAuth Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OAuth 2.0 surface to the remote MCP server so Claude Code's "Connect via URL" (and claude.ai / Cowork connectors) can sign in and obtain a token with no manually pasted API key.

**Architecture:** OAuth logic lives in two unit-testable units — `src/auth/oauth.ts` (pure: metadata builders + PKCE verify) and `src/auth/oauth-provider.ts` (an `OAuthProvider` class holding in-memory client + auth-code maps, given a `mintSession` callback + injectable clock). Fastify routes in `src/index.ts` are thin wrappers. The OAuth **access token is a real `cts_` session** minted via the existing session layer, so `onRequest` resolution and per-tool tenant isolation need zero change. v1 keeps clients/codes in-memory (no Prisma migration → no boot-migration risk); persistence is a documented follow-up.

**Tech Stack:** TypeScript, Fastify, Node `node:test` + `node:assert/strict`, `node:crypto`.

**Design decisions (resolved spec open-questions):**
- **Account selection:** v1 scopes the issued session to the user's primary membership (exactly like a fresh Console login via `mintSession`). Multi-account picker at consent = follow-up.
- **Scope:** v1 issues a session-equivalent token (full account scope). OAuth `scope` param is accepted and echoed but not yet narrowed. Per-scope mapping = follow-up.
- **Token lifetime:** the 7-day `cts_` session. No refresh token in v1 (host re-runs the flow).
- **Client/code persistence:** in-memory for v1 (single Coolify instance, seconds-long register→token window). Documented limitation.

---

## File Structure

- Create: `src/auth/oauth.ts` — pure metadata builders + `verifyPkceS256`, shared types.
- Create: `src/auth/oauth.test.ts` — unit tests for the pure helpers.
- Create: `src/auth/oauth-provider.ts` — `OAuthProvider` class (DCR + auth-code + exchange).
- Create: `src/auth/oauth-provider.test.ts` — unit tests for the provider.
- Modify: `src/core/control-plane.ts` — add public `mintSessionForOAuth(userId)` delegating to private `mintSession`.
- Modify: `src/index.ts` — add `.well-known/*`, `/register`, `/authorize`, `/token` routes; extend `EXEMPT_PATHS`; add `WWW-Authenticate` to the `/v1/mcp` 401; instantiate `OAuthProvider`.
- Modify: `cantila-console/src/app/(docs)/docs/mcp/page.mdx` — add a "Connect (OAuth)" section.

---

## Task 1: Pure OAuth helpers — metadata + PKCE

**Files:**
- Create: `src/auth/oauth.ts`
- Test: `src/auth/oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/auth/oauth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
  verifyPkceS256,
} from "./oauth";

const BASE = "https://api.cantila.app";

test("protected-resource metadata points at the MCP resource + AS", () => {
  const m = buildProtectedResourceMetadata(BASE);
  assert.equal(m.resource, "https://api.cantila.app/v1/mcp");
  assert.deepEqual(m.authorization_servers, ["https://api.cantila.app"]);
});

test("authorization-server metadata advertises the OAuth endpoints + PKCE", () => {
  const m = buildAuthServerMetadata(BASE);
  assert.equal(m.issuer, BASE);
  assert.equal(m.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(m.token_endpoint, `${BASE}/token`);
  assert.equal(m.registration_endpoint, `${BASE}/register`);
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.ok(m.grant_types_supported.includes("authorization_code"));
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"]);
});

test("verifyPkceS256 accepts a correct verifier and rejects a wrong one", () => {
  const verifier = "abc123_the-verifier_value_long_enough_xxxxxx";
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256("wrong", challenge), false);
  assert.equal(verifyPkceS256(verifier, "not-a-challenge"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/auth/oauth.test.ts`
Expected: FAIL — `Cannot find module './oauth'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/oauth.ts
/* OAuth 2.0 surface for the remote MCP server — pure helpers.
 * The MCP server is otherwise a Bearer-token API; these let an MCP host
 * (Claude Code "Connect via URL", claude.ai/Cowork) discover the auth
 * server and run authorization-code + PKCE. Issued access tokens are
 * ordinary `cts_` sessions, so downstream auth is unchanged. */
import { createHash, timingSafeEqual } from "node:crypto";

/** The MCP resource a token is valid for (RFC 9728). */
export const MCP_RESOURCE_PATH = "/v1/mcp";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export interface OAuthAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scope: string;
  expiresAt: number;
}

export function buildProtectedResourceMetadata(
  baseUrl: string,
): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}${MCP_RESOURCE_PATH}`,
    authorization_servers: [baseUrl],
  };
}

export function buildAuthServerMetadata(baseUrl: string): AuthServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** RFC 7636 §4.6 — base64url(SHA256(verifier)) must equal the challenge.
 *  Constant-time compare on equal-length buffers; unequal length → false. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/auth/oauth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth.ts src/auth/oauth.test.ts
git commit -m "feat(mcp-oauth): pure metadata builders + PKCE S256 verify"
```

---

## Task 2: OAuthProvider — Dynamic Client Registration (RFC 7591)

**Files:**
- Create: `src/auth/oauth-provider.ts`
- Test: `src/auth/oauth-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/auth/oauth-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OAuthProvider } from "./oauth-provider";

function makeProvider(nowMs = 1_000_000) {
  let clock = nowMs;
  const minted: string[] = [];
  const provider = new OAuthProvider({
    now: () => clock,
    mintSession: async (userId: string) => {
      minted.push(userId);
      return { token: `cts_for_${userId}`, expiresAt: "2026-06-08T00:00:00Z" };
    },
  });
  return { provider, minted, advance: (ms: number) => (clock += ms) };
}

test("DCR registers a public client and echoes it back", () => {
  const { provider } = makeProvider();
  const client = provider.registerClient({
    client_name: "Claude Code",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  });
  assert.match(client.client_id, /^mcpc_/);
  assert.equal(client.client_name, "Claude Code");
  assert.deepEqual(client.redirect_uris, [
    "https://claude.ai/api/mcp/auth_callback",
  ]);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.ok(provider.getClient(client.client_id));
});

test("DCR rejects a registration with no redirect_uris", () => {
  const { provider } = makeProvider();
  assert.throws(
    () => provider.registerClient({ client_name: "x", redirect_uris: [] }),
    /redirect_uris/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/auth/oauth-provider.test.ts`
Expected: FAIL — `Cannot find module './oauth-provider'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/oauth-provider.ts
/* In-memory OAuth provider for the MCP connector (v1). Holds dynamically
 * registered clients + pending authorization codes; issues `cts_` sessions
 * as access tokens via the injected `mintSession`. In-memory is acceptable
 * for v1 (single instance, seconds-long register→token window); moving to
 * the Store is a follow-up. */
import { randomBytes } from "node:crypto";
import type { OAuthClient, OAuthAuthCode } from "./oauth";
import { verifyPkceS256 } from "./oauth";

export interface OAuthProviderDeps {
  /** Mint a real Console session for the consenting user. */
  mintSession: (userId: string) => Promise<{ token: string; expiresAt: string }>;
  /** Injectable clock (ms since epoch) for deterministic expiry tests. */
  now: () => number;
}

const AUTH_CODE_TTL_MS = 60_000;

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
}

export class OAuthProvider {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, OAuthAuthCode>();

  constructor(private deps: OAuthProviderDeps) {}

  registerClient(input: {
    client_name?: string;
    redirect_uris?: string[];
  }): RegisteredClient {
    const redirectUris = input.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      throw new Error("redirect_uris must contain at least one URI");
    }
    const clientId = `mcpc_${randomBytes(16).toString("hex")}`;
    this.clients.set(clientId, {
      clientId,
      clientName: input.client_name ?? "MCP client",
      redirectUris,
      createdAt: this.deps.now(),
    });
    return {
      client_id: clientId,
      client_name: input.client_name ?? "MCP client",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/auth/oauth-provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-provider.ts src/auth/oauth-provider.test.ts
git commit -m "feat(mcp-oauth): OAuthProvider with Dynamic Client Registration"
```

---

## Task 3: OAuthProvider — authorization code + token exchange (PKCE)

**Files:**
- Modify: `src/auth/oauth-provider.ts`
- Test: `src/auth/oauth-provider.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
// append to src/auth/oauth-provider.test.ts
import { createHash } from "node:crypto";

function pkce() {
  const verifier = "verifier-" + "x".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

test("authorization-code → token exchange issues a session for the user", async () => {
  const { provider, minted } = makeProvider();
  const client = provider.registerClient({
    client_name: "c",
    redirect_uris: ["https://app/cb"],
  });
  const { verifier, challenge } = pkce();
  const code = provider.createAuthCode({
    clientId: client.client_id,
    redirectUri: "https://app/cb",
    codeChallenge: challenge,
    userId: "user_1",
    scope: "mcp",
  });
  const token = await provider.exchangeCode({
    code,
    codeVerifier: verifier,
    clientId: client.client_id,
    redirectUri: "https://app/cb",
  });
  assert.equal(token.access_token, "cts_for_user_1");
  assert.equal(token.token_type, "Bearer");
  assert.deepEqual(minted, ["user_1"]);
});

test("token exchange rejects a wrong PKCE verifier", async () => {
  const { provider } = makeProvider();
  const client = provider.registerClient({
    client_name: "c",
    redirect_uris: ["https://app/cb"],
  });
  const { challenge } = pkce();
  const code = provider.createAuthCode({
    clientId: client.client_id,
    redirectUri: "https://app/cb",
    codeChallenge: challenge,
    userId: "user_1",
    scope: "mcp",
  });
  await assert.rejects(
    () =>
      provider.exchangeCode({
        code,
        codeVerifier: "the-wrong-verifier",
        clientId: client.client_id,
        redirectUri: "https://app/cb",
      }),
    /invalid_grant/,
  );
});

test("an auth code is single-use", async () => {
  const { provider } = makeProvider();
  const client = provider.registerClient({
    client_name: "c",
    redirect_uris: ["https://app/cb"],
  });
  const { verifier, challenge } = pkce();
  const args = {
    clientId: client.client_id,
    redirectUri: "https://app/cb",
    codeChallenge: challenge,
    userId: "user_1",
    scope: "mcp",
  };
  const code = provider.createAuthCode(args);
  await provider.exchangeCode({
    code,
    codeVerifier: verifier,
    clientId: client.client_id,
    redirectUri: "https://app/cb",
  });
  await assert.rejects(
    () =>
      provider.exchangeCode({
        code,
        codeVerifier: verifier,
        clientId: client.client_id,
        redirectUri: "https://app/cb",
      }),
    /invalid_grant/,
  );
});

test("an expired auth code is rejected", async () => {
  const { provider, advance } = makeProvider();
  const client = provider.registerClient({
    client_name: "c",
    redirect_uris: ["https://app/cb"],
  });
  const { verifier, challenge } = pkce();
  const code = provider.createAuthCode({
    clientId: client.client_id,
    redirectUri: "https://app/cb",
    codeChallenge: challenge,
    userId: "user_1",
    scope: "mcp",
  });
  advance(61_000);
  await assert.rejects(
    () =>
      provider.exchangeCode({
        code,
        codeVerifier: verifier,
        clientId: client.client_id,
        redirectUri: "https://app/cb",
      }),
    /invalid_grant/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/auth/oauth-provider.test.ts`
Expected: FAIL — `provider.createAuthCode is not a function`.

- [ ] **Step 3: Add `createAuthCode` + `exchangeCode` to OAuthProvider**

```ts
// add these methods inside the OAuthProvider class in src/auth/oauth-provider.ts

  /** Mint a single-use authorization code bound to the PKCE challenge,
   *  client, redirect_uri and the consenting user. Caller (the /authorize
   *  route) has already validated the client + redirect_uri and resolved
   *  the authenticated userId. */
  createAuthCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    userId: string;
    scope: string;
  }): string {
    const code = `mcpa_${randomBytes(24).toString("hex")}`;
    this.codes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      userId: input.userId,
      scope: input.scope,
      expiresAt: this.deps.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** Exchange an authorization code + PKCE verifier for an access token
   *  (a `cts_` session). Throws `Error("invalid_grant: …")` on any
   *  mismatch; the /token route maps that to a 400 OAuth error body. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<{
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope: string;
  }> {
    const rec = this.codes.get(input.code);
    if (!rec) throw new Error("invalid_grant: unknown or used code");
    // single-use: consume immediately, before any further check
    this.codes.delete(input.code);
    if (rec.expiresAt < this.deps.now()) {
      throw new Error("invalid_grant: code expired");
    }
    if (rec.clientId !== input.clientId) {
      throw new Error("invalid_grant: client mismatch");
    }
    if (rec.redirectUri !== input.redirectUri) {
      throw new Error("invalid_grant: redirect_uri mismatch");
    }
    if (!verifyPkceS256(input.codeVerifier, rec.codeChallenge)) {
      throw new Error("invalid_grant: PKCE verification failed");
    }
    const session = await this.deps.mintSession(rec.userId);
    const expiresIn = Math.max(
      0,
      Math.floor((Date.parse(session.expiresAt) - this.deps.now()) / 1000),
    );
    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: rec.scope,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/auth/oauth-provider.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-provider.ts src/auth/oauth-provider.test.ts
git commit -m "feat(mcp-oauth): auth-code issue + PKCE token exchange (single-use, expiring)"
```

---

## Task 4: Public `mintSessionForOAuth` on ControlPlane

**Files:**
- Modify: `src/core/control-plane.ts` (next to `mintSession`, ~line 5176)
- Test: covered indirectly; add a focused test `src/auth/oauth-mint.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/auth/oauth-mint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";

function cpWith(store: InMemoryStore): ControlPlane {
  return new ControlPlane({ store } as never);
}

test("mintSessionForOAuth returns a resolvable cts_ session", async () => {
  const store = new InMemoryStore();
  const cp = cpWith(store);
  const user = await cp.registerUser({
    email: "o@example.com",
    password: "password-123",
    name: "O",
  });
  const { token } = await cp.mintSessionForOAuth(user.id);
  assert.match(token, /^cts_/);
  const resolved = await cp.resolveSession(token);
  assert.ok(resolved, "session should resolve");
  assert.equal(resolved!.user.id, user.id);
});
```

> Note: confirm `registerUser`'s exact signature when implementing — match the
> shape already used in `src/auth/avatar-login.test.ts` if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/auth/oauth-mint.test.ts`
Expected: FAIL — `cp.mintSessionForOAuth is not a function`.

- [ ] **Step 3: Add the public delegator**

```ts
// in src/core/control-plane.ts, immediately AFTER the private mintSession(...) method

  /** Public entry for the MCP OAuth connector: mint a session for a user
   *  who has just consented at /authorize. Same semantics as a fresh
   *  Console login (scoped to the user's primary membership). */
  async mintSessionForOAuth(
    userId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.mintSession(userId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/auth/oauth-mint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/control-plane.ts src/auth/oauth-mint.test.ts
git commit -m "feat(mcp-oauth): public mintSessionForOAuth delegator on ControlPlane"
```

---

## Task 5: Wire HTTP routes + WWW-Authenticate in src/index.ts

**Files:**
- Modify: `src/index.ts` — `EXEMPT_PATHS` (~line 212), `/v1/mcp` 401 path, new routes near the MCP block (~line 2917).

This task is verified manually (no Fastify test harness in the repo). Each sub-step is a single edit; run `npx tsc --noEmit` after to typecheck.

- [ ] **Step 1: Exempt the discovery docs + register the provider**

Near the top imports of `src/index.ts`, add:

```ts
import {
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
  MCP_RESOURCE_PATH,
} from "./auth/oauth";
import { OAuthProvider } from "./auth/oauth-provider";
```

After `cp` is constructed (~line 120), add:

```ts
const oauthProvider = new OAuthProvider({
  now: () => Date.now(),
  mintSession: (userId) => cp.mintSessionForOAuth(userId),
});

/** Public base URL for OAuth metadata + redirects. Prefer an explicit
 *  override, else derive from the request's forwarded host/proto. */
function publicBaseUrl(req: { headers: Record<string, unknown> }): string {
  const override = process.env.CANTILA_PUBLIC_BASE_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? "https";
  const host =
    (req.headers["x-forwarded-host"] as string) ??
    (req.headers["host"] as string) ??
    "api.cantila.app";
  return `${proto}://${host}`;
}
```

Add the two well-known paths to `EXEMPT_PATHS` (~line 212):

```ts
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
```

- [ ] **Step 2: Add `WWW-Authenticate` to the `/v1/mcp` 401**

In the `config.requireAuth` enforcement hook (~line 482), replace the
anonymous-rejection block so an MCP caller learns where discovery lives:

```ts
    const key = getApiKey(req);
    const session = getSessionAuth(req);
    if (!key && !session) {
      cp.recordAuthFailure({
        reason: "no_credentials",
        method: req.method,
        route: url,
      });
      if (url === MCP_RESOURCE_PATH) {
        reply.header(
          "www-authenticate",
          `Bearer resource_metadata="${publicBaseUrl(req)}/.well-known/oauth-protected-resource"`,
        );
      }
      return reply.code(401).send({
        error:
          "authentication required — pass a Bearer API key or session token",
      });
    }
```

- [ ] **Step 3: Add the discovery + OAuth routes** (near the MCP block, ~line 2920)

```ts
// ----- MCP OAuth connector (plan: 2026-06-01-mcp-oauth-connector) -----
app.get("/.well-known/oauth-protected-resource", async (request) => {
  return buildProtectedResourceMetadata(publicBaseUrl(request));
});

app.get("/.well-known/oauth-authorization-server", async (request) => {
  return buildAuthServerMetadata(publicBaseUrl(request));
});

// Dynamic Client Registration (RFC 7591) — public clients only (PKCE).
app.post("/register", async (request, reply) => {
  const body = (request.body ?? {}) as {
    client_name?: string;
    redirect_uris?: string[];
  };
  try {
    const client = oauthProvider.registerClient(body);
    return reply.code(201).send(client);
  } catch (err) {
    return reply.code(400).send({
      error: "invalid_client_metadata",
      error_description: err instanceof Error ? err.message : "invalid",
    });
  }
});

// Authorization endpoint — requires a signed-in Console session. If the
// caller has no `cts_` session yet, bounce them to the Console login and
// return here. (v1 consent is implicit: a signed-in owner authorizing
// their own MCP connector. A consent screen is a follow-up.)
app.get("/authorize", async (request, reply) => {
  const q = request.query as Record<string, string>;
  const client = oauthProvider.getClient(q.client_id ?? "");
  if (!client || !client.redirectUris.includes(q.redirect_uri ?? "")) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  if (q.response_type !== "code" || q.code_challenge_method !== "S256") {
    return reply.code(400).send({ error: "unsupported_response_type" });
  }
  const session = getSessionAuth(request);
  if (!session) {
    const ret = encodeURIComponent(request.url);
    const consoleUrl =
      process.env.CANTILA_CONSOLE_URL ?? "https://console.cantila.app";
    return reply.redirect(`${consoleUrl}/login?next=${ret}`);
  }
  const code = oauthProvider.createAuthCode({
    clientId: q.client_id,
    redirectUri: q.redirect_uri,
    codeChallenge: q.code_challenge,
    userId: session.userId,
    scope: q.scope ?? "mcp",
  });
  const sep = q.redirect_uri.includes("?") ? "&" : "?";
  const state = q.state ? `&state=${encodeURIComponent(q.state)}` : "";
  return reply.redirect(`${q.redirect_uri}${sep}code=${code}${state}`);
});

// Token endpoint — authorization_code + PKCE. Public client, so client
// auth IS the code + verifier (no client secret).
app.post("/token", async (request, reply) => {
  const b = (request.body ?? {}) as Record<string, string>;
  if (b.grant_type !== "authorization_code") {
    return reply.code(400).send({ error: "unsupported_grant_type" });
  }
  try {
    const token = await oauthProvider.exchangeCode({
      code: b.code,
      codeVerifier: b.code_verifier,
      clientId: b.client_id,
      redirectUri: b.redirect_uri,
    });
    reply.header("cache-control", "no-store");
    return reply.code(200).send(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid_grant";
    return reply.code(400).send({
      error: "invalid_grant",
      error_description: msg,
    });
  }
});
```

- [ ] **Step 4: Typecheck + run the full test suite**

Run: `npx tsc --noEmit` → Expected: no errors.
Run: `node --test --import tsx "src/**/*.test.ts"` → Expected: all pass (incl. the new oauth tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(mcp-oauth): discovery + register/authorize/token routes + WWW-Authenticate"
```

---

## Task 6: Manual end-to-end verify + docs

**Files:**
- Modify: `cantila-console/src/app/(docs)/docs/mcp/page.mdx`

- [ ] **Step 1: Start the server locally with auth on**

Run: `CANTILA_REQUIRE_AUTH=1 CANTILA_PUBLIC_BASE_URL=http://localhost:8080 npx tsx src/index.ts`
(use the repo's actual start script / port if different)

- [ ] **Step 2: Verify discovery is public + 401 carries the pointer**

```bash
curl -s http://localhost:8080/.well-known/oauth-authorization-server | jq .
curl -s -D - -o /dev/null -X POST http://localhost:8080/v1/mcp -d '{}' \
  | grep -i www-authenticate
```
Expected: metadata JSON with `registration_endpoint`; a `WWW-Authenticate`
header pointing at `/.well-known/oauth-protected-resource`.

- [ ] **Step 3: Real client check** — add the server to Claude Code via the
  Connect/URL flow against the local instance and confirm it reaches the
  tool list. (Account must exist; sign in when bounced to the Console login.)

- [ ] **Step 4: Add a "Connect (OAuth)" section to the docs**

In `cantila-console/src/app/(docs)/docs/mcp/page.mdx`, after the intro
`<Note>`, document that hosts supporting OAuth can paste the URL and sign
in (no key needed), while the API-key/header path remains for CI/agents.

- [ ] **Step 5: Commit + open/flip PRs**

```bash
git add -A && git commit -m "docs(mcp): document OAuth Connect flow"
# control-plane PR #10 flips from draft → ready once Task 5 lands.
```

---

## Execution log (2026-06-01)

**Status: API side COMPLETE + live-verified. 180/180 tests pass; `tsc --noEmit` clean.**

Tasks 1–5 implemented TDD on branch `feat/mcp-oauth-connector`:
- `src/auth/pkce.ts` gained `verifyPkceS256` (reused, not duplicated).
- `src/auth/oauth.ts` — metadata builders + types.
- `src/auth/oauth-provider.ts` — DCR + single-use/expiring auth codes + PKCE exchange.
- `src/core/control-plane.ts` — public `mintSessionForOAuth`.
- `src/index.ts` — discovery docs, `/register`, `/authorize`, `/v1/oauth/grant`, `/token`, `WWW-Authenticate`, urlencoded body parser.

**Design correction during execution (vs the original Task 5):** Cantila sessions
are Bearer tokens, NOT cookies, so a browser navigation to the API `/authorize`
can't identify the logged-in user. The flow was split: `GET /authorize` validates
then **302s to the Console consent page** (`console.cantila.app/oauth/consent`),
which calls the **session-gated `POST /v1/oauth/grant`** to mint the code. Only
`/register`, `/authorize`, `/token`, and the two `.well-known` docs are anon-exempt.

**Live smoke (local, `CANTILA_REQUIRE_AUTH=1`):** discovery anon-200 ✓; `/v1/mcp`
401 carries the `WWW-Authenticate` resource_metadata pointer ✓; DCR ✓; full
register-user → grant → token → **use token on `/v1/mcp` → `tools/list` = 28
tools** ✓; single-use + bad-PKCE + redirect-mismatch all rejected ✓.

**Remaining follow-ups (NOT done — require their own work):**
1. **Console `/oauth/consent` page** (cantila-console repo) — the browser-facing
   consent UI that calls `POST /v1/oauth/grant`. Without it the *button* isn't
   end-to-end, though every API piece behind it is built + proven.
2. **Persistence** — clients/codes are in-memory (v1). Move to the Store for
   multi-instance / restart survival (needs a Prisma migration **and** a
   `boot-migrations.ts` entry per the deploy gotcha).
3. **Console "Connect (OAuth)" docs section** — add once (1) ships.
4. Refresh tokens + per-scope narrowing + multi-account consent picker (deferred).

## Self-Review

- **Spec coverage:** discovery metadata ✓ (T1/T5), WWW-Authenticate ✓ (T5), DCR ✓ (T2/T5), authorize+PKCE+consent ✓ (T3/T5), token ✓ (T3/T5), tenant isolation reuse ✓ (T4 mints `cts_`; existing `onRequest`/MCP threading untouched). Spec's refresh-token + scope-narrowing + persistence are explicitly deferred (documented above) — not gaps, scoped-out for v1.
- **Type consistency:** `OAuthClient`/`OAuthAuthCode` defined in `oauth.ts`, consumed by `oauth-provider.ts`; provider methods `registerClient`/`getClient`/`createAuthCode`/`exchangeCode` are named identically in tests and routes; `mintSessionForOAuth` returns `{token,expiresAt}` matching `mintSession`.
- **Placeholders:** none — every code step is concrete. The one runtime assumption (`registerUser` signature in T4) is flagged to confirm against `avatar-login.test.ts` at implement time.

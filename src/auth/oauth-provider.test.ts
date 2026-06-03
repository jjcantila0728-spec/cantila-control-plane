import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function pkce() {
  const verifier = "verifier-" + "x".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
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

function registeredClient(provider: OAuthProvider) {
  return provider.registerClient({
    client_name: "c",
    redirect_uris: ["https://app/cb"],
  });
}

test("authorization-code → token exchange issues a session for the user", async () => {
  const { provider, minted } = makeProvider();
  const client = registeredClient(provider);
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
  assert.equal(token.scope, "mcp");
  assert.ok(token.expires_in > 0);
  assert.deepEqual(minted, ["user_1"]);
});

test("token exchange rejects a wrong PKCE verifier", async () => {
  const { provider } = makeProvider();
  const client = registeredClient(provider);
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

test("token exchange rejects a redirect_uri mismatch", async () => {
  const { provider } = makeProvider();
  const client = registeredClient(provider);
  const { verifier, challenge } = pkce();
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
        codeVerifier: verifier,
        clientId: client.client_id,
        redirectUri: "https://evil/cb",
      }),
    /invalid_grant/,
  );
});

test("an auth code is single-use", async () => {
  const { provider } = makeProvider();
  const client = registeredClient(provider);
  const { verifier, challenge } = pkce();
  const code = provider.createAuthCode({
    clientId: client.client_id,
    redirectUri: "https://app/cb",
    codeChallenge: challenge,
    userId: "user_1",
    scope: "mcp",
  });
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
  const client = registeredClient(provider);
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

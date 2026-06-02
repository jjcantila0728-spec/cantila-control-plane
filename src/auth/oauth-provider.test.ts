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

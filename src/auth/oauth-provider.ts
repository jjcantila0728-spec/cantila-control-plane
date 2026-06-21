/* OAuth provider for the MCP connector.
 *
 * Issues `cts_` Console sessions as access tokens via the injected
 * `mintSession`. Dynamically-registered (RFC 7591) clients are STATELESS:
 * the client metadata (name + redirect_uris) is signed into the `client_id`
 * itself with `secret` (HMAC-SHA256), so any instance can verify a client
 * forever — registrations survive a control-plane redeploy AND work across
 * multiple instances with no shared store. This fixes the "MCP connection
 * drops after a deploy" class of bug: hosts (Claude, Cowork) cache their
 * client_id and reuse it on re-auth, and the server must still recognise it.
 *
 * A short-lived in-memory map is kept only as a same-instance cache + as the
 * fallback when no `secret` is configured (dev). Authorization codes stay
 * in-memory: they live for ~60s between /authorize and /token, far shorter
 * than a deploy window, so persisting them buys nothing. */
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { OAuthClient, OAuthAuthCode } from "./oauth";
import { verifyPkceS256 } from "./pkce";

/** Authorization codes are single-use and short-lived (RFC 6749 §4.1.2). */
const AUTH_CODE_TTL_MS = 60_000;

export interface OAuthProviderDeps {
  /** Mint a real Console session for the consenting user. */
  mintSession: (
    userId: string,
  ) => Promise<{ token: string; expiresAt: string }>;
  /** Injectable clock (ms since epoch) for deterministic expiry tests. */
  now: () => number;
  /** Signing key for stateless client_ids (CANTILA_SECRET_KEY in prod).
   *  When unset, falls back to random opaque ids held only in memory. */
  secret?: string;
}

/** Encode a stateless, signed client_id: `mcpc_<payload>.<sig>` where
 *  payload is base64url(JSON{n,r,t}) and sig is HMAC-SHA256(secret, payload). */
function signClientId(
  secret: string,
  meta: { clientName: string; redirectUris: string[]; createdAt: number },
): string {
  const payload = Buffer.from(
    JSON.stringify({ n: meta.clientName, r: meta.redirectUris, t: meta.createdAt }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `mcpc_${payload}.${sig}`;
}

/** Verify + decode a signed client_id. Returns null if it isn't a valid
 *  signed id for this secret (tampered, wrong key, or legacy opaque id). */
function verifyClientId(secret: string, clientId: string): OAuthClient | null {
  if (!clientId.startsWith("mcpc_")) return null;
  const body = clientId.slice("mcpc_".length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null; // legacy opaque id (no signature segment)
  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Array.isArray(p.r) || p.r.length === 0) return null;
    return {
      clientId,
      clientName: typeof p.n === "string" ? p.n : "MCP client",
      redirectUris: p.r,
      createdAt: typeof p.t === "number" ? p.t : 0,
    };
  } catch {
    return null;
  }
}

/** The RFC 7591 registration response we echo back to the host. */
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

  /** RFC 7591 Dynamic Client Registration. Public clients only (PKCE, no
   *  secret), which is what MCP hosts register. */
  registerClient(input: {
    client_name?: string;
    redirect_uris?: string[];
  }): RegisteredClient {
    const redirectUris = input.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      throw new Error("redirect_uris must contain at least one URI");
    }
    const clientName = input.client_name ?? "MCP client";
    const createdAt = this.deps.now();
    // Stateless signed id when a secret is configured (survives redeploy +
    // multi-instance); random opaque id otherwise (dev, in-memory only).
    const clientId = this.deps.secret
      ? signClientId(this.deps.secret, { clientName, redirectUris, createdAt })
      : `mcpc_${randomBytes(16).toString("hex")}`;
    this.clients.set(clientId, {
      clientId,
      clientName,
      redirectUris,
      createdAt,
    });
    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
  }

  getClient(clientId: string): OAuthClient | undefined {
    // Same-instance fast path.
    const cached = this.clients.get(clientId);
    if (cached) return cached;
    // Durable path: verify the signature so a client registered before a
    // redeploy (or on another instance) is still recognised.
    if (this.deps.secret) {
      const verified = verifyClientId(this.deps.secret, clientId);
      if (verified) {
        this.clients.set(clientId, verified); // re-cache for this instance
        return verified;
      }
    }
    return undefined;
  }

  /** Mint a single-use authorization code bound to the PKCE challenge,
   *  client, redirect_uri and the consenting user. The /authorize route
   *  has already validated the client + redirect_uri and resolved the
   *  authenticated userId before calling this. */
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
   *  mismatch; the /token route maps that to a 400 OAuth error body. The
   *  code is consumed on first use, before any further validation, so a
   *  replay can never succeed even if a later check would have failed. */
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
}

/* In-memory OAuth provider for the MCP connector (v1).
 *
 * Holds dynamically-registered (RFC 7591) clients + pending authorization
 * codes, and issues `cts_` Console sessions as access tokens via the
 * injected `mintSession`. In-memory is acceptable for v1 — single Coolify
 * instance, and the register→authorize→token window is seconds long.
 * Moving clients/codes to the Store (surviving restarts / multi-instance)
 * is a documented follow-up. */
import { randomBytes } from "node:crypto";
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
    const clientId = `mcpc_${randomBytes(16).toString("hex")}`;
    const clientName = input.client_name ?? "MCP client";
    this.clients.set(clientId, {
      clientId,
      clientName,
      redirectUris,
      createdAt: this.deps.now(),
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
    return this.clients.get(clientId);
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

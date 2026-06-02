/* In-memory OAuth provider for the MCP connector (v1).
 *
 * Holds dynamically-registered (RFC 7591) clients + pending authorization
 * codes, and issues `cts_` Console sessions as access tokens via the
 * injected `mintSession`. In-memory is acceptable for v1 — single Coolify
 * instance, and the register→authorize→token window is seconds long.
 * Moving clients/codes to the Store (surviving restarts / multi-instance)
 * is a documented follow-up. */
import { randomBytes } from "node:crypto";
import type { OAuthClient } from "./oauth";

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
}

/* OAuth 2.0 surface for the remote MCP server — pure metadata + types.
 *
 * The MCP server (`POST /v1/mcp`) is otherwise a Bearer-token API. These
 * builders let an MCP host (Claude Code "Connect via URL", claude.ai /
 * Cowork) discover the authorization server (RFC 8414 / RFC 9728) and run
 * authorization-code + PKCE. Issued access tokens are ordinary `cts_`
 * Console sessions, so downstream auth + tenant isolation are unchanged.
 *
 * PKCE lives in ./pkce (derivePkceChallenge / verifyPkceS256) — not
 * duplicated here. */

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

/** A dynamically-registered (RFC 7591) public client. */
export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

/** A pending authorization code, bound to its PKCE challenge + consenter. */
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

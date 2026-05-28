/* ============================================================
   OidcSsoProvider — the real OpenID Connect implementation of the
   `SsoProvider` port (plan §4.3.1 / §5.4 — per-user SSO auth).

   Same `SsoProvider` interface as `StubSsoProvider`; same call sites;
   no architectural change — exactly the adapter-swap pattern
   `StripeRealAdapter` and `ClaudeAiAnalyser` use. `sso.ts` selects this
   adapter at boot when the `CANTILA_OIDC_*` env vars are present.

   Flow (OIDC Authorization Code):
     • `startLogin`    — builds the IdP's `/authorize` URL.
     • `completeLogin` — exchanges the `code` at the IdP token endpoint
                         (a direct server-to-server TLS call), decodes
                         the returned `id_token` claims, validates
                         `iss` / `aud` / `exp` / `email`, and returns
                         the verified profile.

   Security note: the `id_token` is received over a direct TLS
   back-channel from the token endpoint, so its provenance is already
   authenticated by TLS — OIDC Core §3.1.3.7 permits skipping the JWT
   signature check in that case. Production hardening should still add
   explicit JWKS-based RS256 signature verification as defence in depth.

   STATUS — real code, INFRASTRUCTURE-BLOCKED to exercise: it needs a
   real IdP (Okta / Auth0 / Google / Entra / …), the six `CANTILA_OIDC_*`
   env vars, and a redirect URI registered with that IdP. Offline, the
   bundled `StubSsoProvider` runs instead.
   ============================================================ */

import type { SsoProfile, SsoProvider } from "./sso";

export interface OidcSsoProviderOpts {
  /** IdP issuer identifier — must match the `iss` claim on the id_token. */
  issuer: string;
  /** The IdP's OAuth2 `/authorize` endpoint. */
  authorizeUrl: string;
  /** The IdP's OAuth2 `/token` endpoint. */
  tokenUrl: string;
  /** OAuth2 client id registered with the IdP. */
  clientId: string;
  /** OAuth2 client secret. */
  clientSecret: string;
  /** Redirect URI registered with the IdP — sent on both the authorize
   *  request and the token exchange, and they must match. */
  redirectUri: string;
}

export class OidcSsoProvider implements SsoProvider {
  readonly live = true;
  readonly label: string;
  private opts: OidcSsoProviderOpts;

  constructor(opts: OidcSsoProviderOpts) {
    for (const [k, v] of Object.entries(opts)) {
      if (!v) {
        throw new Error(`OidcSsoProvider: missing required option "${k}"`);
      }
    }
    this.opts = opts;
    this.label = `OIDC (${opts.issuer})`;
  }

  /** Build the IdP authorize URL the browser should be sent to. */
  startLogin(input: { redirectUri: string; state: string }): {
    authorizeUrl: string;
  } {
    const u = new URL(this.opts.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.opts.clientId);
    // The port hands a `redirectUri`, but a real OIDC client must send
    // the redirect URI registered with the IdP (fixed app config), and
    // the token exchange must echo the same value — so `opts.redirectUri`
    // wins. `input.redirectUri` is intentionally not used here.
    u.searchParams.set("redirect_uri", this.opts.redirectUri);
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", input.state);
    return { authorizeUrl: u.toString() };
  }

  /** Complete a login from the IdP callback — exchange the code and
   *  return the verified profile. Throws on any invalid login. */
  async completeLogin(input: {
    code?: string;
    email?: string;
  }): Promise<SsoProfile> {
    const code = input.code?.trim();
    if (!code) {
      throw new Error("OIDC callback is missing the authorization code");
    }

    // Exchange the code for tokens at the IdP token endpoint.
    let tokenRes: Response;
    try {
      tokenRes = await fetch(this.opts.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.opts.redirectUri,
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
        }).toString(),
      });
    } catch (err) {
      throw new Error(
        `OIDC token exchange could not reach the IdP: ${
          err instanceof Error ? err.message : "network error"
        }`,
      );
    }
    if (!tokenRes.ok) {
      throw new Error(
        `OIDC token exchange was rejected (HTTP ${tokenRes.status})`,
      );
    }
    const tokens = (await tokenRes.json().catch(() => null)) as {
      id_token?: string;
    } | null;
    const idToken = tokens?.id_token;
    if (!idToken) {
      throw new Error("OIDC token response carried no id_token");
    }

    // Decode + validate the id_token claims (see the security note in
    // the file header on signature verification).
    const claims = decodeJwtClaims(idToken);
    if (claims.iss !== this.opts.issuer) {
      throw new Error(
        "OIDC id_token issuer does not match the configured issuer",
      );
    }
    if (!audienceMatches(claims.aud, this.opts.clientId)) {
      throw new Error(
        "OIDC id_token audience does not include this client",
      );
    }
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      throw new Error("OIDC id_token has expired");
    }
    const email =
      typeof claims.email === "string"
        ? claims.email.trim().toLowerCase()
        : "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("OIDC id_token did not carry a usable email claim");
    }
    const name =
      typeof claims.name === "string" && claims.name
        ? claims.name
        : email.split("@")[0];
    return { email, name, provider: this.label };
  }
}

/** Decode (not cryptographically verify) a JWT's claims payload. */
function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("OIDC id_token is not a well-formed JWT");
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error("OIDC id_token claims are not valid JSON");
  }
}

/** OIDC `aud` may be a single string or an array — the client id must
 *  be present either way. */
function audienceMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === "string") return aud === clientId;
  if (Array.isArray(aud)) return aud.includes(clientId);
  return false;
}

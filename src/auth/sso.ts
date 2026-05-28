/* ============================================================
   SSO / OIDC provider port (plan §4.3.1 / §5.4 — per-user auth).

   The control plane talks to the `SsoProvider` interface and never
   to an OIDC library directly — so swapping the bundled stub for a
   real OpenID Connect provider is a one-file change behind the same
   shape (the same adapter pattern `StripeAdapter` and `AiAnalyser`
   use).

   `StubSsoProvider` is the default. It performs no network call:
   `startLogin` returns a deterministic authorize URL and
   `completeLogin` trusts the email handed to it — which keeps the
   prototype's "any credentials open the Console" behaviour while the
   real IdP wiring is deferred to a production hardening pass.

   The real provider — `OidcSsoProvider` in `./sso-oidc.ts` — implements
   the same two methods against an IdP: `startLogin` builds the OIDC
   authorize URL; `completeLogin` exchanges the `code` for tokens at the
   IdP token endpoint and returns the verified profile. `ssoProvider`
   below auto-selects it when the `CANTILA_OIDC_*` env vars are present —
   no call site changes.
   ============================================================ */

import { OidcSsoProvider } from "./sso-oidc";

export interface SsoProfile {
  /** Verified email from the identity provider. */
  email: string;
  /** Display name, when the IdP supplies one. */
  name?: string;
  /** Opaque provider label — recorded on the audit trail. */
  provider: string;
}

export interface SsoProvider {
  /** Provider label shown in the Console ("Stub SSO", "Okta", …). */
  readonly label: string;
  /** Whether this provider talks to a real IdP. The Console can render
   *  a "(stub)" badge when false. */
  readonly live: boolean;

  /** Begin a login — returns the URL the browser should be sent to.
   *  `redirectUri` is where the IdP returns the user afterwards. */
  startLogin(input: { redirectUri: string; state: string }): {
    authorizeUrl: string;
  };

  /** Complete a login from the IdP callback. The stub accepts an
   *  `email` directly; a real provider ignores it and reads the
   *  verified identity out of `code`. Throws on an invalid login. */
  completeLogin(input: { code?: string; email?: string }): Promise<SsoProfile>;
}

/** Bundled, network-free SSO stub. */
export class StubSsoProvider implements SsoProvider {
  readonly label = "Stub SSO";
  readonly live = false;

  startLogin(input: { redirectUri: string; state: string }): {
    authorizeUrl: string;
  } {
    // A real provider points at the IdP's /authorize endpoint. The stub
    // points back at the redirect URI so the dev flow round-trips with
    // no external hop.
    const u = new URL(input.redirectUri);
    u.searchParams.set("state", input.state);
    u.searchParams.set("stub", "1");
    return { authorizeUrl: u.toString() };
  }

  async completeLogin(input: {
    code?: string;
    email?: string;
  }): Promise<SsoProfile> {
    const email = (input.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("a valid email is required for stub SSO login");
    }
    return { email, name: email.split("@")[0], provider: this.label };
  }
}

/** Select the SSO provider from the environment. When the full set of
 *  `CANTILA_OIDC_*` vars is present a real `OidcSsoProvider` is wired;
 *  otherwise the network-free `StubSsoProvider` — exactly the way the
 *  Stripe and AI adapters auto-select on env. */
function selectSsoProvider(): SsoProvider {
  const e = process.env;
  if (
    e.CANTILA_OIDC_ISSUER &&
    e.CANTILA_OIDC_AUTHORIZE_URL &&
    e.CANTILA_OIDC_TOKEN_URL &&
    e.CANTILA_OIDC_CLIENT_ID &&
    e.CANTILA_OIDC_CLIENT_SECRET &&
    e.CANTILA_OIDC_REDIRECT_URI
  ) {
    return new OidcSsoProvider({
      issuer: e.CANTILA_OIDC_ISSUER,
      authorizeUrl: e.CANTILA_OIDC_AUTHORIZE_URL,
      tokenUrl: e.CANTILA_OIDC_TOKEN_URL,
      clientId: e.CANTILA_OIDC_CLIENT_ID,
      clientSecret: e.CANTILA_OIDC_CLIENT_SECRET,
      redirectUri: e.CANTILA_OIDC_REDIRECT_URI,
    });
  }
  return new StubSsoProvider();
}

/** The SSO provider the control plane uses — a real `OidcSsoProvider`
 *  when the OIDC env vars are set, the bundled stub otherwise. */
export const ssoProvider: SsoProvider = selectSsoProvider();

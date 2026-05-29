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

   The real providers — `OidcSsoProvider` (Google, via `./sso-oidc.ts`)
   and `GitHubOAuthProvider` (`./sso-github.ts`) — implement the same two
   methods against an IdP: `startLogin` builds the authorize URL;
   `completeLogin` exchanges the `code` and returns the verified profile.
   A small **registry** keyed by id (`"google"`, `"github"`) wires each
   from its `CANTILA_*` env vars at boot, falling back to a labelled
   `StubSsoProvider` when not configured — no call site changes.
   ============================================================ */

import { googleProviderFromEnv } from "./sso-oidc";
import { GitHubOAuthProvider } from "./sso-github";

export interface SsoProfile {
  /** Verified email from the identity provider. */
  email: string;
  /** Display name, when the IdP supplies one. */
  name?: string;
  /** Profile picture URL from the IdP (Google `picture`, GitHub
   *  `avatar_url`), when supplied. */
  avatarUrl?: string;
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
  startLogin(input: {
    redirectUri: string;
    state: string;
    /** PKCE S256 challenge. Honoured by OIDC providers that support PKCE
     *  (Google); ignored by GitHub OAuth Apps. */
    codeChallenge?: string;
  }): { authorizeUrl: string };

  /** Complete a login from the IdP callback. The stub accepts an
   *  `email` directly; a real provider ignores it and reads the
   *  verified identity out of `code`. Throws on an invalid login. */
  completeLogin(input: {
    code?: string;
    email?: string;
    /** PKCE verifier echoed at the token exchange. */
    codeVerifier?: string;
  }): Promise<SsoProfile>;
}

/** Bundled, network-free SSO stub. */
export class StubSsoProvider implements SsoProvider {
  readonly label = "Stub SSO";
  readonly live = false;

  startLogin(input: {
    redirectUri: string;
    state: string;
    codeChallenge?: string;
  }): {
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
    codeVerifier?: string;
  }): Promise<SsoProfile> {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SSO stub is disabled in production — configure a real provider",
      );
    }
    const email = (input.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error("a valid email is required for stub SSO login");
    }
    return { email, name: email.split("@")[0], provider: this.label };
  }
}

/** Provider ids the Console can request. */
export type SsoProviderId = "google" | "github";

function githubProviderFromEnv(): GitHubOAuthProvider | null {
  const e = process.env;
  if (
    !e.CANTILA_GITHUB_CLIENT_ID ||
    !e.CANTILA_GITHUB_CLIENT_SECRET ||
    !e.CANTILA_GITHUB_REDIRECT_URI
  ) {
    return null;
  }
  return new GitHubOAuthProvider({
    clientId: e.CANTILA_GITHUB_CLIENT_ID,
    clientSecret: e.CANTILA_GITHUB_CLIENT_SECRET,
    redirectUri: e.CANTILA_GITHUB_REDIRECT_URI,
  });
}

/** Build the registry once at boot. A provider with no env config falls
 *  back to a labelled StubSsoProvider so the dev flow still round-trips
 *  and the Console can render the button with a "(stub)" badge. */
function buildRegistry(): Record<SsoProviderId, SsoProvider> {
  const stub = (label: string): SsoProvider => {
    const s = new StubSsoProvider();
    (s as { label: string }).label = label;
    return s;
  };
  return {
    google: googleProviderFromEnv() ?? stub("Google (stub)"),
    github: githubProviderFromEnv() ?? stub("GitHub (stub)"),
  };
}

const registry = buildRegistry();

/** Look up a provider by id; throws on an unknown id. */
export function getSsoProvider(id: string): SsoProvider {
  const p = (registry as Record<string, SsoProvider | undefined>)[id];
  if (!p) throw new Error(`unknown SSO provider "${id}"`);
  return p;
}

/** List the configured providers for the Console login page. */
export function availableSsoProviders(): Array<{
  id: SsoProviderId;
  label: string;
  live: boolean;
}> {
  return (Object.keys(registry) as SsoProviderId[]).map((id) => ({
    id,
    label: registry[id].label,
    live: registry[id].live,
  }));
}

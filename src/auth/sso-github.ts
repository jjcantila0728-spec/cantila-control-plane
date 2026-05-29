/* ============================================================
   GitHubOAuthProvider — OAuth2 (not OIDC) implementation of the
   SsoProvider port. GitHub issues no id_token, so completeLogin
   exchanges the code for an access token, then reads the verified
   primary email from the GitHub REST API. Same port, same call
   sites as OidcSsoProvider — selected by the registry in sso.ts
   when the CANTILA_GITHUB_* env vars are present.
   ============================================================ */

import type { SsoProfile, SsoProvider } from "./sso";

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Pick the email GitHub considers authoritative: the verified primary,
 *  else any verified email, else null (we refuse unverified emails to
 *  avoid account-takeover via email collision). */
export function selectGithubPrimaryEmail(emails: GithubEmail[]): string | null {
  const verifiedPrimary = emails.find((e) => e.primary && e.verified);
  if (verifiedPrimary) return verifiedPrimary.email.trim().toLowerCase();
  const anyVerified = emails.find((e) => e.verified);
  return anyVerified ? anyVerified.email.trim().toLowerCase() : null;
}

export interface GitHubOAuthProviderOpts {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

export class GitHubOAuthProvider implements SsoProvider {
  readonly live = true;
  readonly label = "GitHub";
  private opts: GitHubOAuthProviderOpts;

  constructor(opts: GitHubOAuthProviderOpts) {
    for (const [k, v] of Object.entries(opts)) {
      if (!v) throw new Error(`GitHubOAuthProvider: missing option "${k}"`);
    }
    this.opts = opts;
  }

  startLogin(input: { redirectUri: string; state: string }): {
    authorizeUrl: string;
  } {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", this.opts.clientId);
    u.searchParams.set("redirect_uri", this.opts.redirectUri);
    u.searchParams.set("scope", "read:user user:email");
    u.searchParams.set("state", input.state);
    return { authorizeUrl: u.toString() };
  }

  async completeLogin(input: { code?: string }): Promise<SsoProfile> {
    const code = input.code?.trim();
    if (!code) throw new Error("GitHub callback is missing the code");

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        code,
        redirect_uri: this.opts.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange rejected (HTTP ${tokenRes.status})`);
    }
    const token = (await tokenRes.json().catch(() => null)) as {
      access_token?: string;
    } | null;
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error("GitHub token response carried no access_token");

    const authHeaders = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "cantila-control-plane",
    };

    const emailsRes = await fetch(EMAILS_URL, { headers: authHeaders });
    if (!emailsRes.ok) {
      throw new Error(`GitHub email lookup failed (HTTP ${emailsRes.status})`);
    }
    const emails = (await emailsRes.json().catch(() => [])) as GithubEmail[];
    const email = selectGithubPrimaryEmail(Array.isArray(emails) ? emails : []);
    if (!email) {
      throw new Error("GitHub account has no verified email");
    }

    let name: string | undefined;
    let avatarUrl: string | undefined;
    const userRes = await fetch(USER_URL, { headers: authHeaders });
    if (userRes.ok) {
      const profile = (await userRes.json().catch(() => null)) as {
        name?: unknown;
        login?: unknown;
        avatar_url?: unknown;
      } | null;
      name =
        (typeof profile?.name === "string" && profile.name) ||
        (typeof profile?.login === "string" ? profile.login : undefined);
      avatarUrl =
        typeof profile?.avatar_url === "string" && profile.avatar_url
          ? profile.avatar_url
          : undefined;
    }
    return {
      email,
      name: name ?? email.split("@")[0],
      avatarUrl,
      provider: this.label,
    };
  }
}

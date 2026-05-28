/* ============================================================
   SeoFixer port — how the SeoAgent commits mechanical fixes to
   the cantila-console repo. Two adapters:

   - `StubSeoFixer` — default. Logs intent, mutates nothing. Used
     when GITHUB_TOKEN is unset OR SEO_AGENT_AUTO_APPLY is false.
     The SeoAgent still emits the proposal so the action journal
     records what *would* have changed.

   - `GitHubSeoFixer` — live. Commits files via the GitHub REST
     Contents API (PUT /repos/:owner/:repo/contents/:path). One
     commit per fix, authored as `seo-agent <noreply@cantila.app>`
     with a `[seo-agent]` prefix in the message so the log is
     easy to scan.

   Same env-gated swap-in pattern as StripeAdapter, MailProvider,
   and AiAnalyser (plan §15.3 — env-gated adapter factory).
   ============================================================ */

import { config } from "../config";

export interface SeoFixerFile {
  /** Path inside the cantila-console repo, e.g. `"src/app/sitemap.ts"`. */
  path: string;
  /** New file content (full file). For surgical edits, the agent
   *  computes the new content before calling the fixer. */
  content: string;
  /** One-line commit message — the fixer prefixes with `[seo-agent] `. */
  message: string;
}

export interface SeoFixerResult {
  ok: boolean;
  /** Human-readable detail for the action journal. */
  detail: string;
  /** Commit SHA when the live fixer ran a commit; empty for the stub. */
  commitSha?: string;
}

export interface SeoFixer {
  /** Display label — `"stub"` or `"github"`. Surfaced on the agent
   *  status snapshot so the operator can see which mode is live. */
  readonly label: string;
  /** Whether the fixer actually mutates the repo. `false` for stub. */
  readonly live: boolean;

  /** Commit a single file change. Returns ok=true even on the stub —
   *  the SeoAgent reads `live` to decide whether to count this as a
   *  real fix or a queued proposal. */
  commitFile(file: SeoFixerFile): Promise<SeoFixerResult>;
}

/* ---------- stub ---------- */

export class StubSeoFixer implements SeoFixer {
  readonly label = "stub";
  readonly live = false;

  async commitFile(file: SeoFixerFile): Promise<SeoFixerResult> {
    return {
      ok: true,
      detail: `stub: would commit ${file.path} ("${file.message}")`,
    };
  }
}

/* ---------- github live adapter ---------- */

interface GitHubFileResponse {
  sha: string;
}

interface GitHubCommitResponse {
  commit: { sha: string };
}

export class GitHubSeoFixer implements SeoFixer {
  readonly label = "github";
  readonly live = true;

  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly branch: string = "main",
  ) {
    if (!token || !repo) {
      throw new Error(
        "GitHubSeoFixer requires GITHUB_TOKEN and GITHUB_REPO (owner/repo)",
      );
    }
  }

  private async getCurrentSha(path: string): Promise<string | null> {
    const res = await fetch(
      `https://api.github.com/repos/${this.repo}/contents/${encodeURIComponent(path)}?ref=${this.branch}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "cantila-seo-agent",
        },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitHub GET contents failed: ${res.status} ${await res.text()}`,
      );
    }
    const body = (await res.json()) as GitHubFileResponse;
    return body.sha;
  }

  async commitFile(file: SeoFixerFile): Promise<SeoFixerResult> {
    try {
      const sha = await this.getCurrentSha(file.path);
      const res = await fetch(
        `https://api.github.com/repos/${this.repo}/contents/${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "cantila-seo-agent",
          },
          body: JSON.stringify({
            message: `[seo-agent] ${file.message}`,
            content: Buffer.from(file.content, "utf-8").toString("base64"),
            branch: this.branch,
            ...(sha ? { sha } : {}),
            committer: {
              name: "Cantila SEO Agent",
              email: "seo-agent@cantila.app",
            },
            author: {
              name: "Cantila SEO Agent",
              email: "seo-agent@cantila.app",
            },
          }),
        },
      );
      if (!res.ok) {
        return {
          ok: false,
          detail: `GitHub PUT failed: ${res.status} ${await res.text()}`,
        };
      }
      const body = (await res.json()) as GitHubCommitResponse;
      return {
        ok: true,
        detail: `committed ${file.path} (sha ${body.commit.sha.slice(0, 7)})`,
        commitSha: body.commit.sha,
      };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : "GitHubSeoFixer threw",
      };
    }
  }
}

/* ---------- factory ---------- */

/** Pick the active SeoFixer based on env. Live adapter requires both
 *  SEO_AGENT_AUTO_APPLY=true AND GITHUB_TOKEN + GITHUB_REPO set.
 *  Mirrors the env-gated factory pattern other adapters use. */
export function selectSeoFixer(): SeoFixer {
  if (
    config.seoAgentAutoApply &&
    config.githubToken &&
    config.githubRepo
  ) {
    return new GitHubSeoFixer(config.githubToken, config.githubRepo);
  }
  return new StubSeoFixer();
}

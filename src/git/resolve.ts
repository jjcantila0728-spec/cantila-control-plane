import { config } from "../config";
import type { GitProvider } from "./provider";
import type { RepoRef } from "./types";
import { parseRepo } from "../github/github-files";
import { GitHubGitProvider } from "./github-provider";
import { CantilaGitProvider } from "./cantila-provider";
import { StubGitProvider } from "./stub-provider";

// Singletons — providers are stateless except the stub (which holds the
// in-memory store, so dev edits persist across calls within a process).
const githubProvider = new GitHubGitProvider(config.githubToken);
const stubProvider = new StubGitProvider();
const cantilaProvider = config.giteaUrl
  ? new CantilaGitProvider(config.giteaUrl, config.giteaToken)
  : null;

export type AccountLike = { id: string; handle: string };
export type ProjectLike = { repoHost?: string | null; repoUrl?: string | null; slug: string };

/** Gitea-valid org name for an account: its handle, else acct-<id>. */
export function orgNameForAccount(account: AccountLike): string {
  const h = (account.handle || "").trim();
  return h ? h : `acct-${account.id}`;
}

/** Pick the provider for a project. cantila → Gitea (or stub when GITEA_URL
 *  is empty); otherwise GitHub. */
export function gitProviderFor(project: ProjectLike): GitProvider {
  if (project.repoHost === "cantila") return cantilaProvider ?? stubProvider;
  return githubProvider;
}

/** The RepoRef for a project under its provider. */
export function repoRefFor(project: ProjectLike, account: AccountLike): RepoRef {
  if (project.repoHost === "cantila") {
    return { owner: orgNameForAccount(account), repo: project.slug };
  }
  const parsed = parseRepo(project.repoUrl ?? "");
  if (!parsed) throw new Error("no-repo");
  return parsed;
}

/** Exposed for ensureProjectRepo (provisioning needs the Gitea/stub provider
 *  regardless of the project's current repoHost). Returns the SAME stub
 *  singleton used by gitProviderFor so in-process writes persist. */
export function cantilaOrStubProvider(): GitProvider {
  return cantilaProvider ?? stubProvider;
}

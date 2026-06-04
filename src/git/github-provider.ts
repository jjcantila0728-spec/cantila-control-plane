import type { GitProvider } from "./provider";
import type { RepoRef, WriteInput, DeleteInput, FileNode, FileContent } from "./types";
import { GitError } from "./types";
import * as gh from "../github/github-files";

/** Adapter over the existing github-files functions. Behavior-preserving. */
export class GitHubGitProvider implements GitProvider {
  constructor(private token: string) {}

  private wrap<T>(p: Promise<T>): Promise<T> {
    return p.catch((e) => {
      const status = (e as { status?: number }).status ?? 502;
      throw new GitError(status, (e as Error).message);
    });
  }

  getDefaultBranch(repo: RepoRef): Promise<string> {
    return this.wrap(gh.getDefaultBranch(repo, this.token));
  }
  listTree(repo: RepoRef, ref?: string): Promise<FileNode[]> {
    return this.wrap(
      (async () => gh.listTree(repo, ref || (await gh.getDefaultBranch(repo, this.token)), this.token))(),
    );
  }
  readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent> {
    return this.wrap(
      (async () => gh.readFile(repo, path, ref || (await gh.getDefaultBranch(repo, this.token)), this.token))(),
    );
  }
  archive(repo: RepoRef, ref?: string): Promise<{ data: Uint8Array; filename: string }> {
    return this.wrap(
      (async () => {
        const branch = ref || (await gh.getDefaultBranch(repo, this.token));
        return { data: await gh.archive(repo, branch, this.token), filename: `${repo.repo}.zip` };
      })(),
    );
  }
  writeFile(repo: RepoRef, input: WriteInput) {
    return this.wrap(gh.writeFile(repo, input, this.token));
  }
  deleteFile(repo: RepoRef, input: DeleteInput) {
    return this.wrap(gh.deleteFile(repo, input, this.token));
  }
  async createRepo(): Promise<{ cloneUrl: string; defaultBranch: string }> {
    throw new GitError(400, "createRepo is not supported for GitHub-connected projects");
  }
}

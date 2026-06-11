import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";

export interface GitProvider {
  getDefaultBranch(repo: RepoRef): Promise<string>;
  listTree(repo: RepoRef, ref?: string): Promise<FileNode[]>;
  readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent>;
  /** Whole-repo archive as a real .zip (binary-faithful, incl. images/fonts). */
  archive(repo: RepoRef, ref?: string): Promise<{ data: Uint8Array; filename: string }>;
  writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }>;
  deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }>;
  /** Create a repo under `owner` (org). Idempotent: returns the existing
   *  repo if it already exists. GitHub adapter throws (unsupported). */
  createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }>;
  /** Bootstrap-clone: have the git BACKEND pull `cloneAddr` (full history)
   *  into a new repo under `owner` — no client-side `git push` involved.
   *  Idempotent: returns the existing repo if it already exists.
   *  `authToken` authenticates against the SOURCE host for private repos.
   *  GitHub adapter throws (unsupported). */
  migrateRepo(input: {
    owner: string;
    name: string;
    cloneAddr: string;
    authToken?: string;
    private?: boolean;
  }): Promise<{ cloneUrl: string; defaultBranch: string }>;
}

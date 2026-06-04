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
}

/* Shared git types — used by the GitProvider port and all adapters. */
export interface RepoRef {
  owner: string;
  repo: string;
}
export interface FileNode {
  path: string;
  type: "blob" | "tree";
  sha: string;
}
export interface FileContent {
  content: string; // decoded UTF-8
  sha: string;
  encoding: "utf-8";
}
export interface WriteInput {
  path: string;
  content: string; // UTF-8 (adapter base64-encodes)
  sha?: string; // required for update; omit for create
  message?: string;
  branch: string;
}
export interface DeleteInput {
  path: string;
  sha: string;
  message?: string;
  branch: string;
}
/** Provider-agnostic HTTP error carrying an upstream status. The file
 *  routes already map: content 404→404; provider/token/stale-sha→409;
 *  unreachable/5xx→502. */
export class GitError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

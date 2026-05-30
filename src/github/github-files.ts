/* ============================================================
   GitHub Contents-API client for project files.
   Reads the connected repo's tree + file contents, and commits
   edits/creates/deletes back to the default branch. Used by the
   console workspace file-tree (read-only fallback when no token).
   ============================================================ */

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Parse an https GitHub repo URL into {owner, repo}, or null. */
export function parseRepo(repoUrl: string): RepoRef | null {
  if (!repoUrl) return null;
  const m = repoUrl
    .trim()
    .replace(/\/+$/, "")
    .match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

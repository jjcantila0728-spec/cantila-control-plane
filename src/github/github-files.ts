/* ============================================================
   GitHub Contents-API client for project files.
   Reads the connected repo's tree + file contents, and commits
   edits/creates/deletes back to the default branch. Used by the
   console workspace file-tree (read-only fallback when no token).
   ============================================================ */

export type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "../git/types";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "../git/types";

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

// ============================================================
// GitHub Contents-API client
// ============================================================

const API = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

function headers(token: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "cantila-console",
    "x-github-api-version": "2022-11-28",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function gh<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    let msg = `github ${res.status}`;
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) msg = j.message;
    } catch {
      /* ignore */
    }
    throw new GithubError(res.status, msg);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export async function getDefaultBranch(ref: RepoRef, token: string): Promise<string> {
  const repo = await gh<{ default_branch: string }>(
    `${API}/repos/${ref.owner}/${ref.repo}`,
    token,
  );
  return repo.default_branch;
}

/** Full recursive tree (blobs + subtrees) for a branch. */
export async function listTree(
  ref: RepoRef,
  branch: string,
  token: string,
): Promise<FileNode[]> {
  const data = await gh<{ tree: { path: string; type: string; sha: string }[] }>(
    `${API}/repos/${ref.owner}/${ref.repo}/git/trees/${branch
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?recursive=1`,
    token,
  );
  return data.tree
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => ({ path: t.path, type: t.type as "blob" | "tree", sha: t.sha }));
}

export async function readFile(
  ref: RepoRef,
  path: string,
  branch: string,
  token: string,
): Promise<FileContent> {
  const data = await gh<{ content: string; encoding: string; sha: string }>(
    `${API}/repos/${ref.owner}/${ref.repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(branch)}`,
    token,
  );
  const content =
    data.encoding === "base64"
      ? Buffer.from(data.content, "base64").toString("utf-8")
      : data.content;
  return { content, sha: data.sha, encoding: "utf-8" };
}

function encPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function writeFile(
  ref: RepoRef,
  input: WriteInput,
  token: string,
): Promise<{ commitSha: string; sha: string }> {
  const body = {
    message: input.message ?? `Update ${input.path} via Cantila`,
    content: Buffer.from(input.content, "utf-8").toString("base64"),
    branch: input.branch,
    ...(input.sha ? { sha: input.sha } : {}),
  };
  const data = await gh<{ commit: { sha: string }; content: { sha: string } }>(
    `${API}/repos/${ref.owner}/${ref.repo}/contents/${encPath(input.path)}`,
    token,
    { method: "PUT", body: JSON.stringify(body) },
  );
  return { commitSha: data.commit.sha, sha: data.content.sha };
}

export async function deleteFile(
  ref: RepoRef,
  input: DeleteInput,
  token: string,
): Promise<{ commitSha: string }> {
  const body = {
    message: input.message ?? `Delete ${input.path} via Cantila`,
    sha: input.sha,
    branch: input.branch,
  };
  const data = await gh<{ commit: { sha: string } }>(
    `${API}/repos/${ref.owner}/${ref.repo}/contents/${encPath(input.path)}`,
    token,
    { method: "DELETE", body: JSON.stringify(body) },
  );
  return { commitSha: data.commit.sha };
}

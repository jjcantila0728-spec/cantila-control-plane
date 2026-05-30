# Cantila-hosted Git Store (sub-project A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give repo-less / Cantila-native projects a real Cantila-hosted git repo (Gitea) so they become fully editable through the existing workspace file API, with no console or route changes.

**Architecture:** Introduce a `GitProvider` port; refactor the existing GitHub file logic behind `GitHubGitProvider`; add `CantilaGitProvider` (Gitea `/api/v1`) and `StubGitProvider` (offline). A per-project resolver picks the provider by `Project.repoHost`; `ensureProjectRepo` auto-provisions a Gitea repo for repo-less projects; the existing `cp.*ProjectFile(s)` methods route through the resolver. Gitea runs live on Coolify (env-gated; stub when `GITEA_URL` is empty).

**Tech Stack:** Fastify + Prisma + TypeScript control-plane. Tests: `node:test` run via `npx tsx --test <file>`. Typecheck: `npm run typecheck` (PRE-EXISTING unrelated errors exist in `src/fleet/*` — `@anthropic-ai/claude-agent-sdk` — IGNORE those; only care about errors in files this plan touches).

**Spec:** `docs/superpowers/specs/2026-05-30-cantila-git-store-design.md`
**Branch:** `feat/cantila-git-store` (already created off `origin/master`; spec committed).
**Repo (absolute):** `c:/Users/canti/OneDrive/Documents/Claude/Projects/cantila/cantila-control-plane`

---

## File Structure

**New:**
- `src/git/types.ts` — shared `RepoRef`, `FileNode`, `FileContent`, `WriteInput`, `DeleteInput`, `GitError`.
- `src/git/provider.ts` — `GitProvider` interface.
- `src/git/stub-provider.ts` (+ `.test.ts`) — in-memory provider.
- `src/git/github-provider.ts` — adapter wrapping `github-files.ts`.
- `src/git/cantila-provider.ts` (+ `.test.ts`) — Gitea adapter + response mappers.
- `src/git/resolve.ts` (+ `.test.ts`) — `gitProviderFor`, `repoRefFor`, `orgNameForAccount`, singletons.

**Modified:**
- `src/github/github-files.ts` — re-export shared types from `../git/types` (keep functions).
- `src/config.ts` — `giteaUrl`, `giteaToken`.
- `prisma/schema.prisma` — `Project.repoHost`.
- `src/domain/boot-migrations.ts` — `repoHost` column.
- `src/domain/types.ts` + `src/domain/prisma-store.ts` + `src/domain/store.ts` (in-memory) — map `repoHost`.
- `src/core/control-plane.ts` — `ensureProjectRepo` + rewire the four file methods.

**Infra (runbook task):** Coolify Gitea service + DNS + control-plane env.

---

## PHASE 1 — Port, shared types, adapters

### Task 1: Shared types + GitProvider port

**Files:** Create `src/git/types.ts`, `src/git/provider.ts`; Modify `src/github/github-files.ts`.

- [ ] **Step 1: Create `src/git/types.ts`** (move the type bodies currently in `github-files.ts`; add `GitError`)
```ts
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
```

- [ ] **Step 2: Create `src/git/provider.ts`**
```ts
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";

export interface GitProvider {
  getDefaultBranch(repo: RepoRef): Promise<string>;
  listTree(repo: RepoRef, ref?: string): Promise<FileNode[]>;
  readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent>;
  writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }>;
  deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }>;
  /** Create a repo under `owner` (org). Idempotent: returns the existing
   *  repo if it already exists. GitHub adapter throws (unsupported). */
  createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }>;
}
```

- [ ] **Step 3: Update `src/github/github-files.ts` to re-export the shared types** (avoid duplicate definitions; keep all functions). Replace the local `interface RepoRef`, `FileNode`, `FileContent`, `WriteInput`, `DeleteInput` declarations with a re-export at the top, and keep `GithubError`, `parseRepo`, and the fetch functions:
```ts
export type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "../git/types";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "../git/types";
```
Delete the now-duplicated `export interface RepoRef {...}` etc. blocks (keep `parseRepo`, `GithubError`, `getDefaultBranch`, `listTree`, `readFile`, `writeFile`, `deleteFile`).

- [ ] **Step 4: Typecheck**
Run: `npm run typecheck 2>&1 | grep -v fleet | grep -E "git/|github-files" || echo "clean"`
Expected: `clean`. Also re-run the existing test: `npx tsx --test src/github/github-files.test.ts` → 4/4 pass.

- [ ] **Step 5: Commit**
```bash
git add src/git/types.ts src/git/provider.ts src/github/github-files.ts
git commit -m "feat(git): GitProvider port + shared git types"
```

---

### Task 2: StubGitProvider (TDD)

**Files:** Create `src/git/stub-provider.ts`, `src/git/stub-provider.test.ts`.

- [ ] **Step 1: Write the failing test `src/git/stub-provider.test.ts`**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StubGitProvider } from "./stub-provider";

const repo = { owner: "acme", repo: "site" };

test("createRepo is idempotent and seeds default branch", async () => {
  const p = new StubGitProvider();
  const a = await p.createRepo({ owner: "acme", name: "site" });
  const b = await p.createRepo({ owner: "acme", name: "site" });
  assert.equal(a.defaultBranch, "main");
  assert.equal(b.cloneUrl, a.cloneUrl);
});

test("write then read round-trips and lists in the tree", async () => {
  const p = new StubGitProvider();
  await p.createRepo({ owner: "acme", name: "site" });
  const w = await p.writeFile(repo, { path: "src/a.ts", content: "hi", branch: "main" });
  assert.ok(w.sha);
  const r = await p.readFile(repo, "src/a.ts", "main");
  assert.equal(r.content, "hi");
  const tree = await p.listTree(repo, "main");
  assert.ok(tree.find((n) => n.path === "src/a.ts" && n.type === "blob"));
});

test("delete removes the file", async () => {
  const p = new StubGitProvider();
  await p.createRepo({ owner: "acme", name: "site" });
  const w = await p.writeFile(repo, { path: "x.txt", content: "y", branch: "main" });
  await p.deleteFile(repo, { path: "x.txt", sha: w.sha, branch: "main" });
  await assert.rejects(() => p.readFile(repo, "x.txt", "main"));
});
```

- [ ] **Step 2: Run → FAIL**
Run: `npx tsx --test src/git/stub-provider.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/git/stub-provider.ts`**
```ts
import { createHash } from "node:crypto";
import type { GitProvider } from "./provider";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";
import { GitError } from "./types";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const key = (r: RepoRef) => `${r.owner}/${r.repo}`;

/** In-memory GitProvider for offline dev/tests. Not persisted. */
export class StubGitProvider implements GitProvider {
  private repos = new Map<string, Map<string, string>>(); // key -> path -> content

  async getDefaultBranch(): Promise<string> {
    return "main";
  }

  async createRepo(input: { owner: string; name: string }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    const k = `${input.owner}/${input.name}`;
    if (!this.repos.has(k)) this.repos.set(k, new Map());
    return { cloneUrl: `stub://git/${k}.git`, defaultBranch: "main" };
  }

  private files(r: RepoRef): Map<string, string> {
    const f = this.repos.get(key(r));
    if (!f) throw new GitError(404, "repo not found");
    return f;
  }

  async listTree(r: RepoRef): Promise<FileNode[]> {
    const files = this.files(r);
    const nodes: FileNode[] = [];
    const dirs = new Set<string>();
    for (const path of files.keys()) {
      nodes.push({ path, type: "blob", sha: sha(files.get(path)!) });
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!dirs.has(dir)) {
          dirs.add(dir);
          nodes.push({ path: dir, type: "tree", sha: sha(dir) });
        }
      }
    }
    return nodes;
  }

  async readFile(r: RepoRef, path: string): Promise<FileContent> {
    const files = this.files(r);
    if (!files.has(path)) throw new GitError(404, "file not found");
    return { content: files.get(path)!, sha: sha(files.get(path)!), encoding: "utf-8" };
  }

  async writeFile(r: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }> {
    const files = this.files(r);
    files.set(input.path, input.content);
    const s = sha(input.content);
    return { commitSha: sha(`commit:${input.path}:${s}`), sha: s };
  }

  async deleteFile(r: RepoRef, input: DeleteInput): Promise<{ commitSha: string }> {
    const files = this.files(r);
    files.delete(input.path);
    return { commitSha: sha(`del:${input.path}`) };
  }
}
```

- [ ] **Step 4: Run → PASS**
Run: `npx tsx --test src/git/stub-provider.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**
```bash
git add src/git/stub-provider.ts src/git/stub-provider.test.ts
git commit -m "feat(git): in-memory StubGitProvider"
```

---

### Task 3: GitHubGitProvider (wrap existing logic)

**Files:** Create `src/git/github-provider.ts`.

- [ ] **Step 1: Implement `src/git/github-provider.ts`**
```ts
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
```

- [ ] **Step 2: Typecheck**
Run: `npm run typecheck 2>&1 | grep -v fleet | grep "git/github-provider" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Commit**
```bash
git add src/git/github-provider.ts
git commit -m "feat(git): GitHubGitProvider adapter over github-files"
```

---

### Task 4: CantilaGitProvider (Gitea) + mapper tests

**Files:** Create `src/git/cantila-provider.ts`, `src/git/cantila-provider.test.ts`.

Gitea API notes (differ from GitHub): auth header is `Authorization: token <TOKEN>` (NOT Bearer). The git-trees endpoint needs a **commit/tree sha**, not a branch name, so resolve the branch first via `GET /repos/{o}/{r}/branches/{branch}` → `commit.id`. Contents/PUT/DELETE/create-org/create-repo mirror GitHub closely.

- [ ] **Step 1: Write the failing mapper test `src/git/cantila-provider.test.ts`**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTree, mapContent } from "./cantila-provider";

test("mapTree filters to blob/tree and keeps path+sha", () => {
  const out = mapTree({
    tree: [
      { path: "a.ts", type: "blob", sha: "s1" },
      { path: "dir", type: "tree", sha: "s2" },
      { path: "weird", type: "commit", sha: "s3" },
    ],
  });
  assert.deepEqual(out, [
    { path: "a.ts", type: "blob", sha: "s1" },
    { path: "dir", type: "tree", sha: "s2" },
  ]);
});

test("mapContent base64-decodes to UTF-8", () => {
  const c = mapContent({ content: Buffer.from("hi", "utf-8").toString("base64"), encoding: "base64", sha: "x" });
  assert.equal(c.content, "hi");
  assert.equal(c.sha, "x");
  assert.equal(c.encoding, "utf-8");
});
```

- [ ] **Step 2: Run → FAIL** (`npx tsx --test src/git/cantila-provider.test.ts`).

- [ ] **Step 3: Implement `src/git/cantila-provider.ts`**
```ts
import type { GitProvider } from "./provider";
import type { RepoRef, FileNode, FileContent, WriteInput, DeleteInput } from "./types";
import { GitError } from "./types";

/** Exported pure mappers (unit-tested without network). */
export function mapTree(data: { tree: { path: string; type: string; sha: string }[] }): FileNode[] {
  return data.tree
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => ({ path: t.path, type: t.type as "blob" | "tree", sha: t.sha }));
}
export function mapContent(data: { content: string; encoding: string; sha: string }): FileContent {
  const content =
    data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf-8") : data.content;
  return { content, sha: data.sha, encoding: "utf-8" };
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Gitea-backed GitProvider. base = `${giteaUrl}/api/v1`. */
export class CantilaGitProvider implements GitProvider {
  private base: string;
  constructor(
    giteaUrl: string,
    private token: string,
  ) {
    this.base = `${giteaUrl.replace(/\/+$/, "")}/api/v1`;
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `token ${this.token}`,
    };
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `gitea ${res.status}`;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* ignore */
      }
      throw new GitError(res.status, msg);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const r = await this.req<{ default_branch: string }>(`/repos/${repo.owner}/${repo.repo}`);
    return r.default_branch;
  }

  private async branchTreeSha(repo: RepoRef, branch: string): Promise<string> {
    const b = await this.req<{ commit: { id: string } }>(
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(branch)}`,
    );
    return b.commit.id;
  }

  async listTree(repo: RepoRef, ref?: string): Promise<FileNode[]> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const treeSha = await this.branchTreeSha(repo, branch);
    const data = await this.req<{ tree: { path: string; type: string; sha: string }[] }>(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${treeSha}?recursive=true`,
    );
    return mapTree(data);
  }

  async readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent> {
    const branch = ref || (await this.getDefaultBranch(repo));
    const data = await this.req<{ content: string; encoding: string; sha: string }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    return mapContent(data);
  }

  async writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }> {
    const body = {
      content: Buffer.from(input.content, "utf-8").toString("base64"),
      message: input.message ?? `Update ${input.path} via Cantila`,
      branch: input.branch,
      ...(input.sha ? { sha: input.sha } : {}),
    };
    const method = input.sha ? "PUT" : "POST";
    const data = await this.req<{ commit: { sha: string }; content: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(input.path)}`,
      { method, body: JSON.stringify(body) },
    );
    return { commitSha: data.commit.sha, sha: data.content.sha };
  }

  async deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }> {
    const body = {
      sha: input.sha,
      message: input.message ?? `Delete ${input.path} via Cantila`,
      branch: input.branch,
    };
    const data = await this.req<{ commit: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/contents/${encPath(input.path)}`,
      { method: "DELETE", body: JSON.stringify(body) },
    );
    return { commitSha: data.commit.sha };
  }

  async createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }> {
    // ensure the org exists (idempotent)
    await this.req(`/orgs/${input.owner}`).catch(async (e) => {
      if (e instanceof GitError && e.status === 404) {
        await this.req(`/orgs`, { method: "POST", body: JSON.stringify({ username: input.owner }) });
      } else {
        throw e;
      }
    });
    try {
      const r = await this.req<{ clone_url: string; default_branch: string }>(
        `/orgs/${input.owner}/repos`,
        {
          method: "POST",
          body: JSON.stringify({
            name: input.name,
            private: input.private ?? true,
            auto_init: true,
            default_branch: "main",
          }),
        },
      );
      return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
    } catch (e) {
      // already exists → fetch it
      if (e instanceof GitError && (e.status === 409 || e.status === 422)) {
        const r = await this.req<{ clone_url: string; default_branch: string }>(
          `/repos/${input.owner}/${input.name}`,
        );
        return { cloneUrl: r.clone_url, defaultBranch: r.default_branch || "main" };
      }
      throw e;
    }
  }
}
```

Note: Gitea PUT requires `sha` for updates; create uses POST without `sha`. `auto_init: true` seeds an initial commit so the repo has a `main` branch immediately.

- [ ] **Step 4: Run → PASS** (`npx tsx --test src/git/cantila-provider.test.ts`, 2 tests).

- [ ] **Step 5: Typecheck**
Run: `npm run typecheck 2>&1 | grep -v fleet | grep "git/cantila-provider" || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**
```bash
git add src/git/cantila-provider.ts src/git/cantila-provider.test.ts
git commit -m "feat(git): CantilaGitProvider (Gitea adapter)"
```

---

## PHASE 2 — Config, schema, resolution, provisioning, wiring

### Task 5: Config env

**Files:** Modify `src/config.ts`.

- [ ] **Step 1: Add to the config object** (next to `githubToken`):
```ts
  /** Cantila-hosted Gitea base URL (e.g. https://git.cantila.app). Empty →
   *  the StubGitProvider is used for repoHost="cantila" projects. */
  giteaUrl: process.env.GITEA_URL ?? "",
  /** Gitea admin API token used to create orgs/repos and read/write files. */
  giteaToken: process.env.GITEA_TOKEN ?? "",
```

- [ ] **Step 2: Typecheck** `npm run typecheck 2>&1 | grep -v fleet | grep "config" || echo "clean"` → `clean`.

- [ ] **Step 3: Commit**
```bash
git add src/config.ts
git commit -m "feat(git): gitea env config"
```

---

### Task 6: Project.repoHost column + migration + store mapping

**Files:** Modify `prisma/schema.prisma`, `src/domain/boot-migrations.ts`, `src/domain/types.ts`, `src/domain/prisma-store.ts`, the in-memory store.

- [ ] **Step 1: Add the column to `prisma/schema.prisma`** (in `model Project`, near `repoUrl`):
```prisma
  /// Which git host backs this project's source: "github" (user-connected
  /// external repo) or "cantila" (auto-provisioned Gitea repo). Nullable +
  /// default for rows created before this column.
  repoHost      String?       @default("github")
```
Run `npx prisma generate` after.

- [ ] **Step 2: Add the boot-migration** — open `src/domain/boot-migrations.ts`, copy the shape of an existing entry (e.g. the `coolifyAppUuid` one) and add a new array entry:
```ts
  {
    id: "project-repo-host",
    sql: `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "repoHost" TEXT DEFAULT 'github';`,
  },
```
(Match the EXACT field names/shape the neighboring entries use — if they use `description` instead of `id`, mirror that.)

- [ ] **Step 3: Map `repoHost` through the domain** — find the `Project` type in `src/domain/types.ts` and add `repoHost?: string | null;` (mirror how `repoUrl` is typed). Then in `src/domain/prisma-store.ts`, wherever a Prisma project row is mapped to the domain `Project` (grep `repoUrl:` in that file), add `repoHost: row.repoHost,`. Do the same in the in-memory store's project shape/defaults (grep `repoUrl` in `src/domain/store.ts`) — default new in-memory projects to `repoHost: "github"`.

- [ ] **Step 4: Typecheck** `npm run typecheck 2>&1 | grep -v fleet | grep -E "types|store|boot-migrations" || echo "clean"` → `clean`.

- [ ] **Step 5: Commit**
```bash
git add prisma/schema.prisma src/domain/boot-migrations.ts src/domain/types.ts src/domain/prisma-store.ts src/domain/store.ts
git commit -m "feat(git): Project.repoHost column + boot migration + store mapping"
```

---

### Task 7: Resolver (provider selection + repo-ref derivation)

**Files:** Create `src/git/resolve.ts`, `src/git/resolve.test.ts`.

- [ ] **Step 1: Write the failing test `src/git/resolve.test.ts`**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgNameForAccount, repoRefFor } from "./resolve";

test("orgNameForAccount uses handle when present", () => {
  assert.equal(orgNameForAccount({ handle: "cantila", id: "acc_1" }), "cantila");
});
test("orgNameForAccount falls back to acct-<id>", () => {
  assert.equal(orgNameForAccount({ handle: "", id: "acc_1" }), "acct-acc_1");
});
test("repoRefFor derives cantila owner/repo from handle+slug", () => {
  const ref = repoRefFor(
    { repoHost: "cantila", repoUrl: "stub://git/cantila/homes.git", slug: "homes" },
    { handle: "cantila", id: "acc_1" },
  );
  assert.deepEqual(ref, { owner: "cantila", repo: "homes" });
});
test("repoRefFor parses github repoUrl", () => {
  const ref = repoRefFor(
    { repoHost: "github", repoUrl: "https://github.com/acme/site.git", slug: "site" },
    { handle: "acme", id: "acc_2" },
  );
  assert.deepEqual(ref, { owner: "acme", repo: "site" });
});
```

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Implement `src/git/resolve.ts`**
```ts
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
 *  regardless of the project's current repoHost). */
export function cantilaOrStubProvider(): GitProvider {
  return cantilaProvider ?? stubProvider;
}
```

- [ ] **Step 4: Run → PASS** (`npx tsx --test src/git/resolve.test.ts`, 4 tests).

- [ ] **Step 5: Typecheck** `npm run typecheck 2>&1 | grep -v fleet | grep "git/resolve" || echo "clean"` → `clean`.

- [ ] **Step 6: Commit**
```bash
git add src/git/resolve.ts src/git/resolve.test.ts
git commit -m "feat(git): provider resolver + repo-ref derivation"
```

---

### Task 8: ensureProjectRepo (auto-provisioning)

**Files:** Modify `src/core/control-plane.ts`. Test: `src/core/ensure-repo.test.ts`.

> **Before coding:** open `control-plane.ts` and confirm (a) the project accessor (`this.deps.store.getProject(id)` per the prior cycle), (b) the account accessor (grep `getAccount` / `findAccount`), and (c) the project-update method (grep how `connectGit`/`scale` persist changes, e.g. `this.deps.store.updateProject(...)`). Use the REAL names.

- [ ] **Step 1: Write the failing test `src/core/ensure-repo.test.ts`** (mirror the in-memory-store + stubs setup used by `src/deploy/pipeline.test.ts`)
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

// NOTE: copy the EXACT ControlPlane constructor wiring from
// src/deploy/pipeline.test.ts::makeCp() — it may require more deps than the
// imports above. Adapt this helper to match that file verbatim.
function makeCp() {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner(),
    dataPlane: stubDataPlane(),
    billing: new StubStripeAdapter(),
    ai: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

test("ensureProjectRepo provisions a cantila repo for a repo-less project, idempotently", async () => {
  const { cp, store } = makeCp();
  // Create an account + a repo-less project via the store's normal helpers.
  // (Use the same helpers pipeline.test.ts uses to create a project.)
  const account = await store.createAccount({ name: "Cantila", handle: "cantila" });
  const project = await store.createProject({ accountId: account.id, name: "Homes", slug: "homes" });

  const first = await cp.ensureProjectRepo(project.id);
  assert.ok(first && first.repoHost === "cantila");
  assert.ok(first.repoUrl && first.repoUrl.length > 0);

  const second = await cp.ensureProjectRepo(project.id);
  assert.equal(second!.repoUrl, first.repoUrl); // idempotent
});
```
(If the store's create helpers have different names/signatures, adapt to the real ones — the goal is: an account with a handle + a project with no `repoUrl`.)

- [ ] **Step 2: Run → FAIL** (`npx tsx --test src/core/ensure-repo.test.ts`).

- [ ] **Step 3: Implement `ensureProjectRepo` in the ControlPlane class**
```ts
import { cantilaOrStubProvider, orgNameForAccount } from "../git/resolve";
// (add to existing imports; config already imported from prior cycle)

/** Ensure a project has a usable git repo. GitHub-connected projects are
 *  returned as-is; repo-less projects get a Cantila (Gitea/stub) repo
 *  provisioned and persisted. Idempotent. Returns the (updated) project or
 *  null if not found. */
async ensureProjectRepo(projectId: string) {
  const project = await this.deps.store.getProject(projectId);   // <-- REAL accessor
  if (!project) return null;
  if (project.repoUrl) return project; // github-connected OR already provisioned
  const account = await this.deps.store.getAccount(project.accountId); // <-- REAL accessor
  if (!account) return null;
  const owner = orgNameForAccount(account);
  const provider = cantilaOrStubProvider();
  const { cloneUrl, defaultBranch } = await provider.createRepo({
    owner,
    name: project.slug,
    private: true,
  });
  const updated = await this.deps.store.updateProject(projectId, {  // <-- REAL update method
    repoUrl: cloneUrl,
    repoHost: "cantila",
    branch: defaultBranch,
  });
  return updated ?? { ...project, repoUrl: cloneUrl, repoHost: "cantila", branch: defaultBranch };
}
```
Adapt `getAccount` / `updateProject` to the real store method names found in Step 0. If `updateProject` doesn't accept these fields, extend its input type accordingly (it already persists `repoUrl` via `connectGit`, so the field set exists — add `repoHost` to that update path).

- [ ] **Step 4: Run → PASS**. Fix until green.

- [ ] **Step 5: Typecheck** `npm run typecheck 2>&1 | grep -v fleet | grep "control-plane" || echo "clean"` → `clean`.

- [ ] **Step 6: Commit**
```bash
git add src/core/control-plane.ts src/core/ensure-repo.test.ts
git commit -m "feat(git): ensureProjectRepo auto-provisioning"
```

---

### Task 9: Rewire the file methods through the resolver

**Files:** Modify `src/core/control-plane.ts`. Test: `src/core/files-via-provider.test.ts`.

The four methods built last cycle (`listProjectFiles`/`readProjectFile`/`writeProjectFile`/`deleteProjectFile`) currently call `ghFiles.*` directly. Route them through `gitProviderFor` + `repoRefFor`, provisioning repo-less projects first.

- [ ] **Step 1: Write the failing integration test `src/core/files-via-provider.test.ts`**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp() {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store, provisioner: stubProvisioner(), dataPlane: stubDataPlane(),
    billing: new StubStripeAdapter(), ai: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

test("a repo-less project is auto-provisioned and becomes editable via the stub", async () => {
  const { cp, store } = makeCp();
  const account = await store.createAccount({ name: "Cantila", handle: "cantila" });
  const project = await store.createProject({ accountId: account.id, name: "Homes", slug: "homes" });

  const write = await cp.writeProjectFile(project.id, { path: "index.html", content: "<h1>hi</h1>" });
  assert.ok(write && "sha" in write);

  const read = await cp.readProjectFile(project.id, "index.html");
  assert.ok(read && "content" in read && read.content === "<h1>hi</h1>");

  const list = await cp.listProjectFiles(project.id);
  assert.ok(list && "files" in list && list.files.some((f) => f.path === "index.html"));
});
```
(Note: `GITEA_URL` is unset in tests, so the cantila provider resolves to the StubGitProvider — but the resolver's stub is a *separate singleton* from any other. Because `ensureProjectRepo` and the file methods both call `cantilaOrStubProvider()`/`gitProviderFor()` which return the SAME module-level `stubProvider` singleton, the written file persists across calls. Verify this holds; if the singletons differ, make `gitProviderFor` for `repoHost==="cantila"` also return `cantilaOrStubProvider()` so both share one stub.)

- [ ] **Step 2: Run → FAIL**.

- [ ] **Step 3: Rewire the four methods.** Replace each method body's provider call. Example for `writeProjectFile`:
```ts
async writeProjectFile(
  projectId: string,
  input: { path: string; content: string; sha?: string; message?: string },
): Promise<{ commitSha: string; sha: string } | { error: "no-repo" | "no-token" } | null> {
  let project = await this.deps.store.getProject(projectId);
  if (!project) return null;
  if (!project.repoUrl) {
    const ensured = await this.ensureProjectRepo(projectId);
    if (!ensured) return null;
    project = ensured;
  }
  const account = await this.deps.store.getAccount(project.accountId);
  if (!account) return null;
  let repo;
  try {
    repo = repoRefFor(project, account);
  } catch {
    return { error: "no-repo" };
  }
  if (project.repoHost !== "cantila" && !config.githubToken) return { error: "no-token" };
  const provider = gitProviderFor(project);
  const branch = project.branch || (await provider.getDefaultBranch(repo));
  return provider.writeFile(repo, { ...input, branch });
}
```
Apply the equivalent shape to `listProjectFiles` (no token guard, provision-then-list), `readProjectFile` (provision-then-read), and `deleteProjectFile` (token guard like write). Keep the existing return-shape contract. Add imports: `import { gitProviderFor, repoRefFor } from "../git/resolve";` (config already imported). The `GitError` thrown by providers propagates to the routes, which already map `.status`.

- [ ] **Step 4: Run → PASS**. Also re-run the full git suite: `npx tsx --test src/git/*.test.ts src/core/*.test.ts` (adjust globbing on Windows — list files explicitly if the glob doesn't expand: `npx tsx --test src/git/stub-provider.test.ts src/git/cantila-provider.test.ts src/git/resolve.test.ts src/core/ensure-repo.test.ts src/core/files-via-provider.test.ts`). Expected: all pass.

- [ ] **Step 5: Typecheck** `npm run typecheck 2>&1 | grep -v fleet | grep "control-plane" || echo "clean"` → `clean`.

- [ ] **Step 6: Commit**
```bash
git add src/core/control-plane.ts src/core/files-via-provider.test.ts
git commit -m "feat(git): route file methods through GitProvider + auto-provision"
```

---

## PHASE 3 — Live Gitea infrastructure (runbook)

### Task 10: Stand up Gitea on Coolify + wire env

This task is an infra runbook, not TDD. Steps are marked **[AGENT]** (drivable via the Coolify API per `docs`/the Coolify deploy notes) or **[USER]** (needs credentials/console access). Do the AGENT steps; pause and hand the USER steps to the human with exact instructions.

- [ ] **Step 1 [USER]: DNS.** Add a Namecheap A record `git.cantila.app` → the Hetzner host IP (same IP the other Coolify apps use). Confirm it resolves.

- [ ] **Step 2 [AGENT]: Deploy Gitea via Coolify.** Create a new Coolify service from the `gitea/gitea:latest` image (or Coolify's Gitea one-click) with:
  - a persistent volume mounted at `/data`,
  - a Postgres database (Coolify-managed) with `GITEA__database__DB_TYPE=postgres` + connection envs,
  - `GITEA__server__DOMAIN=git.cantila.app`, `GITEA__server__ROOT_URL=https://git.cantila.app/`,
  - `GITEA__service__DISABLE_REGISTRATION=true`,
  - Traefik/labels route for `git.cantila.app` with TLS.
  Trigger the deploy and confirm the container is healthy + the URL serves the Gitea UI.

- [ ] **Step 3 [USER]: Admin user + token.** Create the initial admin user (Gitea web UI or `gitea admin user create`), then mint a scoped API token (Settings → Applications) with repo + org + admin scopes. Provide the token to set in env.

- [ ] **Step 4 [AGENT]: Wire control-plane env.** Set on the control-plane Coolify app: `GITEA_URL=https://git.cantila.app`, `GITEA_TOKEN=<token from Step 3>`. Redeploy the control-plane so `config.giteaUrl` is populated (this flips repoHost="cantila" projects from the stub to the real Gitea).

- [ ] **Step 5 [AGENT]: Smoke test.** Against prod, open a repo-less project's workspace file-tree (or call `GET /v1/projects/:id/files` authenticated). Expect: a Gitea repo `<account-handle>/<slug>` is auto-created (auto_init seeds `main` + README), the tree lists it, an edit+save commits, and the commit appears in the Gitea UI. Record the result.

- [ ] **Step 6 [USER]: Backups.** Configure a periodic backup of the Gitea `/data` volume + Postgres (Coolify scheduled backup or a cron `gitea dump`). Note retention.

- [ ] **Step 7: Commit any infra-as-config files** produced (e.g. a compose/service manifest committed to the repo under `infra/` if that's the convention; otherwise none).
```bash
git add -A && git commit -m "chore(git): Gitea service config + env wiring" || echo "no tracked infra files to commit"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- GitProvider port → T1. ✔
- GitHubGitProvider / CantilaGitProvider / StubGitProvider → T3 / T4 / T2. ✔
- `Project.repoHost` + boot-migration + store mapping → T6. ✔
- Resolver (gitProviderFor / repoRefFor / orgNameForAccount) → T7. ✔
- ensureProjectRepo auto-provisioning → T8. ✔
- Route file methods through resolver (no route/console change) → T9. ✔
- Live Gitea on Coolify + config env → T5 (config) + T10 (infra). ✔
- Error normalization to GitError mapped by existing routes → T1 (GitError) + adapters T3/T4 + propagation T9. ✔
- Testing (stub, resolver, repoRef, ensureProjectRepo idempotency, integration, mappers) → T2/T7/T8/T9/T4. ✔

**Out-of-scope honored:** no GitHub↔Cantila sync (D), no deploy-from-store wiring (C), no agent source generation (E) — none appear as tasks. ✔

**Type consistency:** `GitProvider` signatures in T1 match all three adapters (T2/T3/T4) and the resolver/methods (T7/T9). `RepoRef`/`FileNode`/`FileContent`/`WriteInput`/`DeleteInput`/`GitError` defined once in T1, imported everywhere. `repoHost` string `"github"|"cantila"` consistent across T6/T7/T8/T9. `cantilaOrStubProvider`/`gitProviderFor`/`repoRefFor`/`orgNameForAccount` names consistent T7→T8→T9.

**Assumptions to confirm during execution:**
- T6/T8: real store method names (`getAccount`, `updateProject`) and the `updateProject` input field set — copy from existing `connectGit`/sibling methods.
- T8/T9 tests: the exact `ControlPlane` constructor wiring + store create-helpers — copy verbatim from `src/deploy/pipeline.test.ts`.
- T9: the stub singleton must be shared between `ensureProjectRepo` and the file methods (both via the `resolve.ts` module singletons) so writes persist in tests; the plan notes the fix if not.
- T4: Gitea endpoint/field shapes are based on the documented Gitea API; the live smoke test (T10 Step 5) is the real verification — adjust mappers if the live JSON differs.

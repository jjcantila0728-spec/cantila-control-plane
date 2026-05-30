# Cantila-hosted Git Store (sub-project A) — Design

**Date:** 2026-05-30
**Repo:** `cantila-control-plane` (with a one-line config addition; no console changes)
**Status:** Approved design — ready for implementation plan
**Predecessor:** the workspace files API (`/v1/projects/:id/files*`, `src/github/github-files.ts`) shipped 2026-05-30 (PRs control-plane #3 / console #4). This builds the Cantila-owned backing store behind that API.

## Goal

Make "Cantila works like GitHub" real: a Cantila-hosted git store so **repo-less / Cantila-native projects** (no connected GitHub repo) get a real, Cantila-owned git repository and become fully editable through the existing workspace file-tree/editor — with no console changes.

## Context (current reality)

- No object store, no Cantila-owned git today. `connectGit` only registers an *external* repo URL + webhook; `StorageBucket` is user-app metadata, not a source store.
- Native-project source is currently *simulated* (the agent "scaffold" step in `provisioning.ts`).
- Deploy builds from `git | upload | chat` sources via Coolify + nixpacks; there is no "build from Cantila-hosted files" path.
- The workspace file API already speaks GitHub-Contents semantics (tree/blob/sha/commit). Gitea's `/api/v1` contents + git-trees endpoints mirror GitHub's, so most of `github-files.ts` is reusable against a Cantila Gitea instance.

## Substrate decision

**Self-hosted git (Gitea)**, run on Cantila infrastructure. Chosen over object-store/DB because it makes the GitHub parity literal: the file-tree reuses git semantics, future GitHub sync is a `git remote`, history/versioning is free, and Coolify can build from it like any git repo. Forgejo is an API-compatible drop-in if preferred.

## Scope

**In scope (this sub-project):**
1. `GitProvider` port.
2. Three adapters: `GitHubGitProvider` (refactor of existing logic), `CantilaGitProvider` (Gitea), `StubGitProvider` (offline).
3. `Project.repoHost` column (+ `boot-migrations.ts` entry) and a per-project provider resolver.
4. `ensureProjectRepo` auto-provisioning for repo-less projects.
5. Route the existing `cp.*ProjectFile(s)` methods through the resolver (no route/console change).
6. Live Gitea on Coolify (git.cantila.app + volume + admin token + backups) + `config` env.

**Net result:** Cantila-native projects get a real Cantila-hosted git repo and are fully editable via the existing workspace editor.

**Out of scope (later cycles):**
- **C — deploy from the Cantila repo** (unlocked: native projects now have a git URL; Coolify needs clone creds — small follow-up).
- **D — GitHub ↔ Cantila push/pull sync.**
- **E — agents writing real generated source into the store** (replacing the simulated scaffold).

## Architecture

### GitProvider port (`src/git/provider.ts`, new)
Host-agnostic interface mirroring the contents semantics the workspace already uses. Reuses the `RepoRef` / `FileNode` / `FileContent` / `WriteInput` / `DeleteInput` types (moved from `github-files.ts` into a shared `src/git/types.ts`).
```ts
export interface GitProvider {
  getDefaultBranch(repo: RepoRef): Promise<string>;
  listTree(repo: RepoRef, ref?: string): Promise<FileNode[]>;
  readFile(repo: RepoRef, path: string, ref?: string): Promise<FileContent>;
  writeFile(repo: RepoRef, input: WriteInput): Promise<{ commitSha: string; sha: string }>;
  deleteFile(repo: RepoRef, input: DeleteInput): Promise<{ commitSha: string }>;
  createRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ cloneUrl: string; defaultBranch: string }>;
}
```
Follows the `MailProvider`/`TelephonyProvider` adapter-port pattern: stub bundled, real impl env-gated, infra status documented in the file header, "one-file swap."

### Adapters
- **`GitHubGitProvider` (`src/git/github-provider.ts`)** — wraps the existing `github-files.ts` functions; base `https://api.github.com`, token `config.githubToken`. Behavior-preserving refactor. `createRepo` not used for GitHub here (throws `unsupported` if called — GitHub repos are user-connected, not Cantila-created in this cycle).
- **`CantilaGitProvider` (`src/git/cantila-provider.ts`)** — Gitea `/api/v1`, base `config.giteaUrl`, token `config.giteaToken`. Endpoints: `GET /repos/{owner}/{repo}` (default branch), `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=true` (tree), `GET/PUT/DELETE /repos/{owner}/{repo}/contents/{path}` (file ops), `POST /orgs/{org}/repos` (+ ensure org via `GET/POST /orgs/{org}`) for `createRepo`. Absorbs Gitea↔GitHub response-shape diffs (e.g. tree node fields, content base64).
- **`StubGitProvider` (`src/git/stub-provider.ts`)** — in-memory `Map<owner/repo, Map<path,{content,sha}>>`. Deterministic shas (hash of content). Used when `config.giteaUrl` is empty so dev/tests run offline.

### Resolver (`src/git/resolve.ts`, new)
```ts
export function gitProviderFor(project: Project): GitProvider {
  if (project.repoHost === "cantila") {
    return config.giteaUrl ? cantilaProvider : stubProvider;
  }
  return githubProvider;
}
```
- `RepoRef` for a Cantila repo derives from the project: `owner` = a stable, Gitea-valid org name for the account — the account's handle/slug if one exists, else a deterministic `acct-<accountId>` fallback (the plan confirms the real account-identifier field before coding); `repo` = `project.slug`.
- For GitHub projects, `RepoRef` parses `project.repoUrl` (existing `parseRepo`).

### Project model + migration
- Add `repoHost String? @default("github")` to `model Project`.
- Add the column to `src/domain/boot-migrations.ts` (idempotent `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "repoHost" TEXT DEFAULT 'github'`) so the prisma-baselined prod path gets it without a 500.
- Surface `repoHost` through the store/types where `Project` is mapped (`src/domain/types.ts`, `prisma-store.ts`, in-memory store).

### Auto-provisioning (`cp.ensureProjectRepo`)
```
ensureProjectRepo(projectId):
  project = store.getProject(projectId); if !project return null
  if project.repoUrl and repoHost == "github": return existing (GitHub-connected)
  if project.repoUrl and repoHost == "cantila": return existing (already provisioned)
  // repo-less → provision a Cantila repo
  owner = orgNameForAccount(project.accountId)   // handle/slug if present, else acct-<id>
  { cloneUrl, defaultBranch } = cantilaProvider.createRepo({ owner, name: project.slug, private: true })
  seed initial commit (README.md) via writeFile if the repo is empty
  store.update(project, { repoUrl: cloneUrl, repoHost: "cantila", branch: defaultBranch })
  return project
```
- Idempotent: re-entry returns the existing repo. `createRepo` swallows "already exists" from Gitea.
- Called lazily by the file methods (below) and on project create for the build-in-Cantila path.

### Route wiring (no route/console change)
The four `cp.{list,read,write,delete}ProjectFile(s)` methods change their body:
1. Resolve the project (as today).
2. For repo-less projects, `await ensureProjectRepo(project.id)` (writes provision; reads provision-then-empty-tree).
3. `const provider = gitProviderFor(project)` and `const repo = repoRefFor(project)`.
4. Call `provider.listTree/readFile/writeFile/deleteFile` instead of the direct `ghFiles.*`.
5. Keep the same return contract (`{files}` / `FileContent` / `{commitSha,sha}` / `{commitSha}` / `{error:'no-repo'|'no-token'}` / `null`). `no-repo` now only occurs for GitHub projects with an unparseable `repoUrl`; native projects auto-provision instead.

### Gitea infrastructure (live)
- Deploy `gitea/gitea` + Postgres + persistent `/data` volume via Coolify; route at **git.cantila.app** (Namecheap A → Hetzner; Traefik). Disable open registration (admin-created users/orgs only).
- Create an admin user + a scoped admin API token.
- Set `GITEA_URL` (`https://git.cantila.app`) and `GITEA_TOKEN` in the control-plane Coolify env. Back up the Gitea volume.
- `config.ts`: `giteaUrl: process.env.GITEA_URL ?? ""`, `giteaToken: process.env.GITEA_TOKEN ?? ""`.
- Steps the agent can drive via the Coolify API are marked AGENT in the plan; **DNS at Namecheap and minting the admin token are USER-gated**.

## Error handling
- Adapter HTTP failures normalize to a `GitError { status }` (same shape the routes already map): content 404→404; provider/token/stale-sha→409; Gitea unreachable / 5xx→502.
- `ensureProjectRepo` failures (Gitea down during provisioning) surface as 502 from the file routes; the console already shows a non-409 error state.
- Empty `giteaUrl` in dev → `StubGitProvider`, so native-project editing works offline against in-memory state (no silent prod-only path).

## Testing (`node:test`, `npx tsx --test`)
- `StubGitProvider`: write→read round-trip, listTree nesting, delete, deterministic sha, createRepo idempotency.
- `gitProviderFor`: github vs cantila vs (cantila + empty giteaUrl → stub) resolution.
- `repoRefFor`: derives `{owner: handle, repo: slug}` for cantila; `parseRepo(repoUrl)` for github.
- `ensureProjectRepo`: provisions once, idempotent on re-entry, sets `repoHost`/`repoUrl`/`branch` (against stub + in-memory store).
- `cp.*ProjectFile(s)` integration against the stub: a repo-less project becomes editable (write then read) end-to-end.
- Migration: `boot-migrations.ts` includes the `repoHost` column statement.
- `CantilaGitProvider`: response-shape mapping unit-tested against captured Gitea JSON fixtures (no live network).

## Files

**New:** `src/git/types.ts`, `src/git/provider.ts`, `src/git/github-provider.ts`, `src/git/cantila-provider.ts`, `src/git/stub-provider.ts`, `src/git/resolve.ts` (+ `*.test.ts`).
**Modified:** `src/github/github-files.ts` (re-export shared types / keep functions used by the GitHub adapter), `src/core/control-plane.ts` (`ensureProjectRepo` + route-method rewiring), `src/config.ts` (gitea env), `prisma/schema.prisma` (`repoHost`), `src/domain/boot-migrations.ts` (column), `src/domain/types.ts` + stores (map `repoHost`).
**Infra:** Coolify Gitea service + DNS + env (runbook in the plan).

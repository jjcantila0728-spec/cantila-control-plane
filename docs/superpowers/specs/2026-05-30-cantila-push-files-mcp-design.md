# `cantila_push_files` — MCP push-to-our-Gitea deploy tool

**Date:** 2026-05-30
**Status:** Design — approved for planning
**Branch:** `feat/mcp-push-files`

## Problem

An agent talking to the Cantila MCP has no way to get an app's source onto
the platform unless that source already lives in a **public** git repo.

- `cantila_connect_git` + `cantila_deploy` works for a public repo, but for a
  **private** GitHub repo the account has no stored credentials, so the build
  pipeline cannot clone it and a placeholder container goes live instead. (This
  is exactly what happened deploying CantilaHomes: `cantilahomes.cantila.app`
  served the default nginx page and every app route 404'd.)
- The platform already has a first-class **own-git** path — `ensureProjectRepo`
  provisions a `git.cantila.app` (Gitea) repo, and `writeProjectFile` commits to
  it **without any external token** (cantila repos skip the GitHub-token check at
  `control-plane.ts:6356`). Gitea is live in prod (`fleet-smoke-coffee` already
  has a real `git.cantila.app/cantila/...` repo with `repoHost: cantila`).
- **But that own-git path is only reachable through the Console's HTTP files
  API. It is not exposed over MCP.** So the agent on-ramp for code is missing,
  even though every piece downstream of it is built and working.

The deploy engine is complete. The missing link is a single MCP tool that lets
an agent commit files into the project's own Cantila repo and ship them.

## Goal

Add one MCP tool — `cantila_push_files` — that closes the loop:

> agent → MCP `cantila_push_files` → Cantila Gitea repo → deploy → live URL

with no public repo and no GitHub credentials required.

Non-goals (explicitly deferred):

- **No Gitea outbound webhook** (approach B). v1 triggers the deploy directly
  from the tool (approach A). A webhook so external `git push` auto-deploys is a
  later enhancement.
- **No atomic/batch commit.** v1 commits per file (N commits). A single-commit
  `writeFiles` on `CantilaGitProvider` (Gitea `ChangeFiles` API) is a clean
  fast-follow if commit noise matters; it is new git code and is not needed to
  make the feature work.
- **No change to the deploy health check.** See "Known adjacent issue" below.

## Tool surface

```
cantila_push_files
  projectId   string   (required)  The Cantila project id.
  files       array    (required)  Each: { path, content, encoding?, message? }
                                     - path:     repo-relative path (e.g. "src/app/page.tsx")
                                     - content:  file contents
                                     - encoding: "utf-8" (default) | "base64" (binary assets)
                                     - message:  optional per-file commit message
  message     string   (optional)  Default commit message for files without one.
  deploy      boolean  (optional)  Commit then deploy. Defaults to true (approach A).
```

**Result (text):**
- repo URL + branch the files landed on,
- count of files committed + the last commit SHA,
- when `deploy` is true: the deploy status, the live URL, and the step trail.

## Flow (handler in `src/mcp/tools.ts`)

1. Coerce/validate: non-empty `projectId`; `files` is a non-empty array; each
   entry has a non-empty `path` and a string `content`. On failure → `errorText`.
2. `cp.ensureProjectRepo(projectId)` — provisions/returns the project's Cantila
   Gitea repo and persists `repoHost: "cantila"`. Idempotent; already prod-safe
   (refuses the in-memory stub for real traffic, returning repo-less → we surface
   a clear "Cantila git backend not configured" error).
3. Build a `path → sha` map from `cp.listProjectFiles(projectId)` (returns
   `{ files: FileNode[] }`, each with `path` + `sha`) so that re-pushing an
   existing path performs an update (Gitea requires the blob `sha` on update)
   rather than failing. On a fresh repo this returns just the auto-init README.
4. For each file, decode base64 if needed, then
   `cp.writeProjectFile(projectId, { path, content, sha?, message })`. Reuses the
   tested provider path; no token needed for cantila repos. Collect the last
   `commitSha`.
5. If `deploy` !== false → `cp.deploy(projectId, { trigger: "mcp", source: { kind: "chat" } })`.
   Return its `status`, `url`, and `steps`.

## Components & boundaries

- **`cantila_push_files` tool** (new, `src/mcp/tools.ts`, ~60 lines) — the only
  net-new surface. Pure orchestration over existing `ControlPlane` methods; holds
  no git logic of its own.
- **`ControlPlane`** (reused, unchanged): `ensureProjectRepo`, `writeProjectFile`,
  `listProjectFiles`, `deploy`. All four already exist — no new CP method.
- **`CantilaGitProvider`** (reused, unchanged): `writeFile` / `createRepo`.

The tool depends only on the `ControlPlane` interface already passed to
`cantilaTools(cp)`. It can be understood and tested without touching git or HTTP.

## Error handling

- Empty `files` or missing `projectId` → `errorText`, no side effects.
- `ensureProjectRepo` returns null / repo-less (no `GITEA_URL` in this env) →
  `errorText("Cantila git backend not configured — set GITEA_URL")`.
- A `writeProjectFile` returning `{ error }` → stop, report which `path` failed
  and how many succeeded before it (partial-commit transparency; no silent
  truncation).
- Deploy throwing → report files committed successfully + the deploy error, so
  the agent can retry `cantila_deploy` without re-pushing.
- base64 decode failure for an entry → `errorText` naming the offending `path`.

## Testing

**Unit** (fake `ControlPlane`):
- ensure → write(×N, with sha looked up for existing paths) → deploy, in order.
- `deploy: false` short-circuits after commits (no `cp.deploy` call).
- base64 entry is decoded before `writeProjectFile`.
- empty `files` and missing `projectId` error before any side effect.
- repo-less `ensureProjectRepo` surfaces the GITEA_URL error.
- a mid-loop write error reports the failing path + success count.

**Live smoke (acceptance):** push the real CantilaHomes files to
`prj_c40448b1f3a34813` via the hosted MCP at `https://mcp.cantila.app/v1/mcp`
and confirm `https://cantilahomes.cantila.app` serves the actual Next.js app
(landing + `/login` etc. return real content, not the nginx placeholder). This
directly proves the original problem is solved.

## Known adjacent issue (out of scope, flagged)

The deploy verify step is `dataPlane.healthCheck(url)` (`deploy/pipeline.ts:239`),
and the real check treats **any HTTP 200 as "verified."** That is why the
placeholder nginx page passed as a successful deploy. Recommend a separate
follow-up to make verify stricter (e.g. assert an app-specific signal, or reject
a known default-placeholder fingerprint). Kept out of this spec to stay focused.

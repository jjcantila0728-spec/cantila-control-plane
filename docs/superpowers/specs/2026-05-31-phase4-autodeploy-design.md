# Phase 4 — Auto-deploy fleet builds to live URLs — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming) → ready for implementation plan
**Part of:** the Cantila agent-organization north-star (memory `project_cantila_agent_org`). Builds on Phase 1 (fleet engine), Phase 3 (budget governor), and PR #7 (Cantila/Gitea `GitProvider`).

## 1. Goal

When a fleet build's in-session checks pass, **automatically** publish the project workspace to a **Cantila-hosted Gitea repo** and run the **existing git deploy pipeline** → Coolify Nixpacks-builds and serves it at a real `<name>.cantila.app` URL — streamed into the chat. Fully self-hosted (our own git at `git.cantila.app`); no GitHub, no PAT.

## 2. Decisions (locked)
- Bridge: **git push → Coolify Nixpacks**, via the Cantila `GitProvider` (Gitea) from PR #7.
- Trigger: **auto-deploy on successful build**, behind an opt-in env gate.
- Self-hosted git is **live** (`git.cantila.app`, adapter smoke-tested 10/10); PR #7 merged + deployed.

## 3. Architecture — compose existing pieces

The bridge is thin because the control plane already provides every primitive:
- `cp.ensureProjectRepo(projectId)` (`control-plane.ts:6213`) — idempotent: a repo-less project gets a **private Gitea repo** provisioned via `cantilaOrStubProvider().createRepo()`, persisted as `repoUrl`/`repoHost:"cantila"`/`branch`. **Prod-safe**: when `NODE_ENV=production` and `GITEA_URL` is unset it returns the project repo-less (no provisioning) — the bridge then degrades (no deploy).
- `gitProviderFor(project)` + `repoRefFor(project, account)` (`src/git/resolve.ts`) — the provider + `RepoRef` for writing files.
- `provider.writeFile(ref, { path, content, branch, message })` (`src/git/provider.ts`) — commit a file via the Gitea API (uses the provider's configured auth).
- `cp.deploy(projectId, { trigger, source: { kind:"git", ref } })` — the proven 8-step pipeline; Coolify clones the Gitea repo + Nixpacks-builds + serves.

### 3.1 `DeployBridge` (`src/fleet/deploy-bridge.ts`)
- `publish(input: { projectId; accountId; workspaceDir; onEvent }): Promise<BridgeResult>` where `BridgeResult = { deployed: boolean; detail: string; repoUrl?: string; liveUrl?: string }`.
- Deps (injected for testability) — a narrow `BridgeCp` port:
  `{ ensureProjectRepo(id): Promise<Project|null>; getAccount(id): Promise<Account|null>; deploy(id, opts): Promise<...> }`,
  a `providerFor(project): GitProvider`, a `repoRef(project, account): RepoRef`, and a `walk(dir): Promise<{path,content}[]>` (workspace file reader). Defaults wire to the real `cp` + `gitProviderFor`/`repoRefFor` + an fs walk; tests inject stubs (`StubGitProvider`, a fake cp).
- Flow:
  1. `project = await cp.ensureProjectRepo(projectId)`. If `!project?.repoUrl` → return `{ deployed:false, detail:"git backend offline — project left repo-less" }` (graceful; no deploy).
  2. `account = await cp.getAccount(projectId's accountId)`; `ref = repoRef(project, account)`; `provider = providerFor(project)`.
  3. Walk `workspaceDir`; for each file `provider.writeFile(ref, { path, content, branch: project.branch, message: "fleet build" })`. (One commit per file — v1 simplicity; a bulk/tree push is later work.)
  4. `await cp.deploy(projectId, { trigger:"auto", source:{ kind:"git", ref: project.branch } })`; stream a deploy op card via `onEvent`.
  5. Return `{ deployed:true, repoUrl: project.repoUrl, liveUrl: "https://"+project.slug+".cantila.app", detail }`.
- Errors are caught and returned as `{ deployed:false, detail }` — never throw into the build flow.

### 3.2 `ClaudeFleet` build-success signal
- The orchestrator build prompt ends with a sentinel: `FLEET_BUILD_RESULT: ok` (the build was completed AND an in-session build/typecheck passed) or `FLEET_BUILD_RESULT: failed`. `build()` parses it (mirrors the remediation sentinel) and **returns `{ buildOk: boolean }`** (default `false` when absent/unclear — conservative). Streaming behaviour is unchanged.

### 3.3 Trigger wiring (`ProjectOrchestrator`)
- `ProjectOrchestrator` (which holds `cp`) constructs a `DeployBridge(cp)`. After `runBuild`'s `claudeFleet.build(...)` resolves:
  - if `result.buildOk` **and** `fleetConfig().autodeploy` **and** the project's account is the **owner account** (`ownerAccountId()`), call `deployBridge.publish({ projectId, accountId, workspaceDir, onEvent: persistAndForward })`, streaming deploy op cards + a final `result` event carrying the **real** `liveUrl`.
  - otherwise skip (build remains prepared-only).

### 3.4 Config
- `src/fleet/config.ts` gains `autodeploy: boolean` from `FLEET_AUTODEPLOY` (`"on"`/`"true"` → true; default **false**). Opt-in kill switch, set in Coolify when ready.

## 4. Safety
- `FLEET_AUTODEPLOY` default **off** — no autonomous prod deploys until explicitly enabled.
- Deploys **only on a confirmed successful build**, **owner-account only** in v1.
- Claude spend already bounded by the Phase-3 budget governor; `ensureProjectRepo` is prod-safe (no Gitea → repo-less → bridge degrades, no deploy).
- Reuses the existing, tested deploy pipeline — no new prod-mutation code path. Private repos on our own Gitea (not public GitHub).

## 5. Data flow
chat→build → ClaudeFleet session (budget-gated) → `FLEET_BUILD_RESULT: ok` → (autodeploy on, owner acct) → DeployBridge: ensureProjectRepo (Gitea) → writeFile each workspace file → cp.deploy(git) → Coolify clones `git.cantila.app/<org>/<slug>` + Nixpacks-builds + serves → deploy op cards + a `result` with the live `<slug>.cantila.app` URL stream to chat.

## 6. Files
```
src/fleet/deploy-bridge.ts        # NEW — DeployBridge (composes ensureProjectRepo + writeFile + deploy)
src/fleet/deploy-bridge.test.ts   # NEW
src/fleet/config.ts               # EDIT — + autodeploy flag (FLEET_AUTODEPLOY)
src/fleet/config.test.ts          # EDIT — autodeploy default test
src/fleet/claude-fleet.ts         # EDIT — FLEET_BUILD_RESULT sentinel → build() returns {buildOk}
src/fleet/claude-fleet.test.ts    # EDIT — sentinel parse tests
src/agents/project-orchestrator.ts# EDIT — construct DeployBridge; gate autodeploy on buildOk+env+owner
src/agents/project-orchestrator.fleet.test.ts # EDIT — autodeploy-gated trigger tests
```

## 7. Testing (TDD)
- **config**: `autodeploy` false by default; `FLEET_AUTODEPLOY=on` → true.
- **ClaudeFleet**: `build()` returns `{buildOk:true}` when the transcript carries `FLEET_BUILD_RESULT: ok`; `{buildOk:false}` on `failed`/absent; streaming unchanged (existing tests still green).
- **DeployBridge**: with a fake cp (`ensureProjectRepo` returns a project with `repoUrl`+`branch`+`slug`, `getAccount` returns an account, `deploy` records the call) + `StubGitProvider`: `publish` writes each workspace file, calls `deploy` with a git source, returns `deployed:true` + the `liveUrl`; repo-less project (`ensureProjectRepo` → no repoUrl) → `deployed:false`, `deploy` NOT called; an injected fs walk returns 2 files → 2 `writeFile`s.
- **ProjectOrchestrator**: autodeploy off → bridge never called even on `buildOk`; autodeploy on + `buildOk:false` → not called; autodeploy on + `buildOk:true` + owner account → bridge called once and its events forwarded.

## 8. Risks & mitigations
- **Coolify cloning a private Gitea repo** → the existing git deploy path + Coolify's git auth handle it; if a private repo isn't reachable by Coolify, the deploy step fails loudly (visible in chat) rather than silently — flagged as the one live-path integration to verify in the smoke (a deliberate failing case is informative, not destructive).
- **N commits per build** (writeFile-per-file) → acceptable v1; bulk tree push is later work.
- **Runaway auto-deploys** → `FLEET_AUTODEPLOY` off by default + owner-account-only + build-success-only + budget governor on the Claude spend.
- **Branch-base drift** → built on `feat/fleet-autodeploy` off the post-PR#7 master.

## 9. Non-goals (later)
Auto-deploy for arbitrary tenants; bulk/tree push; custom domains on auto-deployed apps; auto-rollback on a bad deploy; the broader "widen autonomy" phase.

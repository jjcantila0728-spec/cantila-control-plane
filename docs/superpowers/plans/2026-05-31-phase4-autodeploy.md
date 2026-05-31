# Phase 4 — Auto-deploy fleet builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a fleet build's in-session checks pass, auto-publish the workspace to a Cantila-hosted Gitea repo and run the existing git deploy pipeline → a live `<slug>.cantila.app` URL — opt-in via `FLEET_AUTODEPLOY`, owner-account only.

**Architecture:** A thin `DeployBridge` (`src/fleet/deploy-bridge.ts`) composes existing primitives: `cp.ensureProjectRepo` (provisions a private Gitea repo), `gitProviderFor`/`repoRefFor` + `provider.writeFile` (push workspace files), and `cp.deploy({source:{kind:"git"}})`. `ClaudeFleet.build` gains a `FLEET_BUILD_RESULT:` sentinel and returns `{buildOk}`; `ProjectOrchestrator` triggers the bridge when `buildOk && FLEET_AUTODEPLOY && owner-account`.

**Tech Stack:** TypeScript (CommonJS), `tsx`, `node:test`. Worktree: `.claude/worktrees/fleet-build-engine` on branch `feat/fleet-autodeploy` (off post-PR#7 master). All builds/tests run offline with `StubGitProvider` + a fake cp.

## Conventions
- Tests: `node:test`, run `npx tsx --test <file>`. The git provider + cp are ALWAYS injected so tests use stubs — never hit live Gitea/Coolify.
- Commit after each task on `feat/fleet-autodeploy`.

## File structure
```
src/fleet/config.ts                # EDIT — + autodeploy (FLEET_AUTODEPLOY)
src/fleet/deploy-bridge.ts         # NEW — DeployBridge
src/fleet/deploy-bridge.test.ts    # NEW
src/fleet/claude-fleet.ts          # EDIT — FLEET_BUILD_RESULT sentinel → build() returns {buildOk}
src/fleet/claude-fleet.test.ts     # EDIT — sentinel tests
src/agents/project-orchestrator.ts # EDIT — DeployBridge + autodeploy gate
src/agents/project-orchestrator.fleet.test.ts # EDIT — gate tests
```

---

## Task 1: `FLEET_AUTODEPLOY` config flag

**Files:** Modify `src/fleet/config.ts`; extend `src/fleet/config.test.ts`.

- [ ] **Step 1: Add failing test** — append to `src/fleet/config.test.ts`:
```ts
test("autodeploy defaults off; FLEET_AUTODEPLOY=on enables it", () => {
  const prev = process.env.FLEET_AUTODEPLOY;
  delete process.env.FLEET_AUTODEPLOY;
  assert.equal(fleetConfig().autodeploy, false);
  process.env.FLEET_AUTODEPLOY = "on";
  assert.equal(fleetConfig().autodeploy, true);
  process.env.FLEET_AUTODEPLOY = "true";
  assert.equal(fleetConfig().autodeploy, true);
  process.env.FLEET_AUTODEPLOY = "off";
  assert.equal(fleetConfig().autodeploy, false);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/config.test.ts` → FAIL.

- [ ] **Step 3: Edit `src/fleet/config.ts`** — add `autodeploy: boolean;` to the `FleetConfig` interface, and in the returned object:
```ts
    autodeploy: /^(on|true|1)$/i.test(process.env.FLEET_AUTODEPLOY ?? ""),
```

- [ ] **Step 4: Run** the config test → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/config.ts src/fleet/config.test.ts
git commit -m "feat(fleet): FLEET_AUTODEPLOY config flag (default off)"
```

---

## Task 2: `ClaudeFleet` build-success sentinel → `build()` returns `{buildOk}`

**Files:** Modify `src/fleet/claude-fleet.ts`; extend `src/fleet/claude-fleet.test.ts`.

**Context:** Read `src/fleet/claude-fleet.ts`. `build`/`chat` call a private `run(projectId, prompt, onEvent, result): Promise<void>` that streams `this.deps.query(...)` through `mapSdkMessage` (and records budget). You will: (a) append a sentinel instruction to the BUILD prompt only; (b) have `run` accumulate assistant text and parse the sentinel; (c) `run` + `build` return `{ buildOk: boolean }` (`chat` may keep returning void or return the same shape and ignore it).

- [ ] **Step 1: Add failing tests** — append to `src/fleet/claude-fleet.test.ts` (imports already present):
```ts
test("build returns buildOk:true when the success sentinel is present", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const q = (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Built it. FLEET_BUILD_RESULT: ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() } as any);
  const res = await fleet.build({ projectId: "pok", plan, onEvent: () => {} });
  assert.equal(res.buildOk, true);
});

test("build returns buildOk:false on failed/absent sentinel", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const q = (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Could not finish. FLEET_BUILD_RESULT: failed" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry() } as any);
  const res = await fleet.build({ projectId: "pfail", plan, onEvent: () => {} });
  assert.equal(res.buildOk, false);
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/claude-fleet.test.ts` → 2 new tests FAIL (build returns void).

- [ ] **Step 3: Edit `src/fleet/claude-fleet.ts`:**
  - In `build()`, append to the `prompt` string (after the existing instruction):
    ```ts
      ` When finished, output a final line EXACTLY one of: FLEET_BUILD_RESULT: ok (you built it AND an in-session build/typecheck passes) or FLEET_BUILD_RESULT: failed (otherwise).`
    ```
  - Change `build` + `run` signatures to `Promise<{ buildOk: boolean }>`; `chat` can call `run` and ignore the return (keep `chat`'s public return as-is or `Promise<{buildOk:boolean}>` — either is fine since callers ignore it).
  - In `run`, accumulate assistant text: add `let texts = "";` before the stream loop; inside the loop, for an assistant message add its text blocks: `if (msg?.type === "assistant") for (const b of msg.message?.content ?? []) if (b.type === "text" && b.text) texts += " " + b.text;` (do this alongside the existing handling — do NOT remove the budget `record` or `mapSdkMessage` calls).
  - For the offline / over-budget / capacity early-returns, `return { buildOk: false };`.
  - At the end of `run`, compute and return: `const buildOk = /FLEET_BUILD_RESULT:\s*ok\b/i.test(texts) && !/FLEET_BUILD_RESULT:\s*failed\b/i.test(texts); return { buildOk };`
  - `build` returns the result of `run`; `chat` calls `run` and returns void or the result (caller ignores).

- [ ] **Step 4: Run** `npx tsx --test src/fleet/claude-fleet.test.ts` → ALL pass (existing + 2 new). `npm run typecheck` → clean. (Note: `ProjectOrchestrator` awaits `fleet.build(...)` without using the return today, so the signature change is backward-compatible.)

- [ ] **Step 5: Commit**
```bash
git add src/fleet/claude-fleet.ts src/fleet/claude-fleet.test.ts
git commit -m "feat(fleet): ClaudeFleet build-success sentinel -> build() returns {buildOk}"
```

---

## Task 3: `DeployBridge`

**Files:** Create `src/fleet/deploy-bridge.ts`; Test `src/fleet/deploy-bridge.test.ts`.

**Context:** Composes `cp.ensureProjectRepo` (returns a `Project` with `repoUrl`/`branch`/`slug`/`accountId`, or a repo-less project when the git backend is offline), `cp.getAccount`, `gitProviderFor`/`repoRefFor` (`src/git/resolve.ts`), `provider.writeFile(ref, {path, content, branch, message})`, and `cp.deploy(projectId, {trigger, source:{kind:"git", ref}})`. `StubGitProvider` (`src/git/stub-provider.ts`) is the test provider. Confirm the valid `DeployTrigger` value (check `src/deploy/pipeline.ts` / where `deploy` is typed) — use a valid one (e.g. `"auto"` if present, else the closest like `"manual"`); the fake cp in tests doesn't care, but the real wiring must typecheck.

- [ ] **Step 1: Write `src/fleet/deploy-bridge.test.ts`:**
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeployBridge } from "./deploy-bridge";
import { StubGitProvider } from "../git/stub-provider";

function fakeCp(project: any) {
  const calls: any = { deploy: 0, deployArg: null };
  return {
    calls,
    ensureProjectRepo: async () => project,
    getAccount: async () => ({ id: project?.accountId ?? "acc", handle: "shop" }),
    deploy: async (_id: string, opts: any) => { calls.deploy++; calls.deployArg = opts; return { ok: true }; },
  };
}
const deps = (cp: any, files: { path: string; content: string }[]) => ({
  cp,
  providerFor: () => new StubGitProvider(),
  repoRef: (p: any) => ({ owner: "shop", repo: p.slug }),
  walk: async () => files,
});

test("publish provisions repo, writes files, deploys, returns liveUrl", async () => {
  const project = { id: "p1", accountId: "acc", slug: "coffee", repoUrl: "https://git.cantila.app/shop/coffee.git", repoHost: "cantila", branch: "main" };
  const cp = fakeCp(project);
  const bridge = new DeployBridge(deps(cp, [{ path: "index.html", content: "<h1>hi</h1>" }, { path: "app.js", content: "1" }]) as any);
  const events: any[] = [];
  const res = await bridge.publish({ projectId: "p1", workspaceDir: "/ws", onEvent: (e: any) => events.push(e) });
  assert.equal(res.deployed, true);
  assert.equal(cp.calls.deploy, 1);
  assert.equal(cp.calls.deployArg.source.kind, "git");
  assert.match(res.liveUrl ?? "", /coffee\.cantila\.app/);
});

test("repo-less project (git backend offline) does NOT deploy", async () => {
  const cp = fakeCp({ id: "p1", accountId: "acc", slug: "coffee", repoUrl: undefined });
  const bridge = new DeployBridge(deps(cp, [{ path: "index.html", content: "x" }]) as any);
  const res = await bridge.publish({ projectId: "p1", workspaceDir: "/ws", onEvent: () => {} });
  assert.equal(res.deployed, false);
  assert.equal(cp.calls.deploy, 0);
  assert.match(res.detail, /offline|repo-less|no repo/i);
});

test("null project (not found) does not deploy", async () => {
  const cp = fakeCp(null);
  const bridge = new DeployBridge(deps(cp, []) as any);
  const res = await bridge.publish({ projectId: "missing", workspaceDir: "/ws", onEvent: () => {} });
  assert.equal(res.deployed, false);
  assert.equal(cp.calls.deploy, 0);
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/deploy-bridge.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/fleet/deploy-bridge.ts`:**
```ts
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { OrchestratorEvent } from "../agents/project-orchestrator";
import type { GitProvider } from "../git/provider";
import type { RepoRef } from "../git/types";
import { gitProviderFor, repoRefFor } from "../git/resolve";

export interface BridgeResult {
  deployed: boolean;
  detail: string;
  repoUrl?: string;
  liveUrl?: string;
}

/** Narrow control-plane surface the bridge needs (injected for tests). */
export interface BridgeCp {
  ensureProjectRepo(projectId: string): Promise<any | null>;
  getAccount(accountId: string): Promise<any | null>;
  deploy(projectId: string, opts: { trigger: any; source: { kind: "git"; ref?: string } }): Promise<any>;
}

export interface DeployBridgeDeps {
  cp: BridgeCp;
  /** Default: gitProviderFor. */
  providerFor?: (project: any) => GitProvider;
  /** Default: repoRefFor. */
  repoRef?: (project: any, account: any) => RepoRef;
  /** Default: recursive workspace walk. */
  walk?: (dir: string) => Promise<{ path: string; content: string }[]>;
}

async function defaultWalk(dir: string): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  async function rec(d: string) {
    let entries: any[];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) await rec(abs);
      else {
        const s = await stat(abs);
        if (s.size > 512 * 1024) continue; // skip large/binary blobs in v1
        out.push({ path: path.relative(dir, abs).split(path.sep).join("/"), content: await readFile(abs, "utf8") });
      }
    }
  }
  await rec(dir);
  return out;
}

export class DeployBridge {
  constructor(private deps: DeployBridgeDeps) {}

  async publish(input: { projectId: string; workspaceDir: string; onEvent: (e: OrchestratorEvent) => void }): Promise<BridgeResult> {
    const { cp } = this.deps;
    const providerFor = this.deps.providerFor ?? (gitProviderFor as any);
    const repoRef = this.deps.repoRef ?? (repoRefFor as any);
    const walk = this.deps.walk ?? defaultWalk;
    try {
      const project = await cp.ensureProjectRepo(input.projectId);
      if (!project) return { deployed: false, detail: "project not found" };
      if (!project.repoUrl) return { deployed: false, detail: "git backend offline — project left repo-less; not deploying" };

      const account = await cp.getAccount(project.accountId);
      const provider = providerFor(project);
      const ref = repoRef(project, account);
      const branch = project.branch ?? "main";

      input.onEvent({ kind: "op_started", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: `Publishing to ${project.repoUrl}` });
      const files = await walk(input.workspaceDir);
      for (const f of files) {
        await provider.writeFile(ref, { path: f.path, content: f.content, branch, message: "fleet build" });
      }
      await cp.deploy(input.projectId, { trigger: "auto", source: { kind: "git", ref: branch } });
      const liveUrl = `https://${project.slug}.cantila.app`;
      input.onEvent({ kind: "op_finished", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: `Deployed ${files.length} file(s)`, status: "ok", detail: liveUrl });
      input.onEvent({ kind: "result", name: project.slug, url: liveUrl, stack: "git · Coolify" });
      return { deployed: true, detail: `published ${files.length} file(s) + deploy queued`, repoUrl: project.repoUrl, liveUrl };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "deploy bridge failed";
      input.onEvent({ kind: "op_finished", opKey: `deploy:${input.projectId}`, agent: "orchestrator", title: "Auto-deploy failed", status: "failed", detail });
      return { deployed: false, detail };
    }
  }
}
```
NOTE: the `trigger: "auto"` literal — confirm against the `deploy` method's `DeployTrigger` type; if `"auto"` isn't a member, use a valid one and update both code + this note. The `as any` casts on the default `providerFor`/`repoRef` absorb the `ProjectLike`/`AccountLike` shape differences from `resolve.ts`.

- [ ] **Step 4: Run** `npx tsx --test src/fleet/deploy-bridge.test.ts` → PASS (3 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/deploy-bridge.ts src/fleet/deploy-bridge.test.ts
git commit -m "feat(fleet): DeployBridge — workspace -> Gitea repo -> git deploy"
```

---

## Task 4: Wire auto-deploy into `ProjectOrchestrator`

**Files:** Modify `src/agents/project-orchestrator.ts`; extend `src/agents/project-orchestrator.fleet.test.ts`.

**Context:** Read `src/agents/project-orchestrator.ts`. It holds `deps.cp: ControlPlane`, constructs `this.claudeFleet`, and `runBuild` calls `await this.claudeFleet.build({...})` routing events through `this.persistAndForward`. You will: construct a `DeployBridge`, and after `build` resolves, gate auto-deploy. `ownerAccountId()` is in `../lib/owner-account`; the project's workspace dir is `workspaceDir(FLEET_WORKSPACE_ROOT default "runtime/projects", projectId)` (import `workspaceDir` from `../fleet/workspace`).

- [ ] **Step 1: Add failing tests** — append to `src/agents/project-orchestrator.fleet.test.ts`:
```ts
import { fleetConfig } from "../fleet/config";

function fakeQueryOk() {
  return (() => async function* () {
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "FLEET_BUILD_RESULT: ok" }] } };
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 };
  })();
}

test("autodeploy OFF: bridge not invoked even on buildOk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; delete process.env.FLEET_AUTODEPLOY;
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: "acc" }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x" }; } } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 0);
  if (prev !== undefined) process.env.FLEET_AUTODEPLOY = prev;
});

test("autodeploy ON + buildOk + owner account: bridge invoked once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "po-"));
  const prev = process.env.FLEET_AUTODEPLOY; process.env.FLEET_AUTODEPLOY = "on";
  const { ownerAccountId } = await import("../lib/owner-account");
  let bridgeCalls = 0;
  const orch = new ProjectOrchestrator({ cp: { getProject: async () => ({ id: "p1", accountId: ownerAccountId() }) } as any, planner: planner as any, images: images as any, fleet: { query: fakeQueryOk() as any, workspaceRoot: root }, deployBridge: { publish: async () => { bridgeCalls++; return { deployed: true, detail: "x", liveUrl: "https://x.cantila.app" }; } } } as any);
  await orch.runBuild({ projectId: "p1", plan: await planner.plan() as any, onEvent: () => {} });
  assert.equal(bridgeCalls, 1);
  if (prev === undefined) delete process.env.FLEET_AUTODEPLOY; else process.env.FLEET_AUTODEPLOY = prev;
});
```
(`planner`, `images`, `ProjectOrchestrator`, `mkdtempSync`, `tmpdir`, `path` already imported at the top of this test file from Phase 1.)

- [ ] **Step 2: Run** `npx tsx --test src/agents/project-orchestrator.fleet.test.ts` → 2 new tests FAIL.

- [ ] **Step 3: Edit `src/agents/project-orchestrator.ts`:**
  - Imports: `import { DeployBridge } from "../fleet/deploy-bridge"; import { fleetConfig } from "../fleet/config"; import { workspaceDir } from "../fleet/workspace"; import { ownerAccountId } from "../lib/owner-account";`
  - Extend `ProjectOrchestratorDeps` with: `deployBridge?: { publish(input: { projectId: string; workspaceDir: string; onEvent: OrchestratorEventHandler }): Promise<{ deployed: boolean; detail: string; liveUrl?: string }> };`
  - Add a field + construct a default in the constructor (reuse the same `workspaceRoot` the fleet uses):
    ```ts
      private deployBridge: { publish(input: { projectId: string; workspaceDir: string; onEvent: OrchestratorEventHandler }): Promise<{ deployed: boolean; detail: string; liveUrl?: string }> };
    ```
    in constructor:
    ```ts
      this.deployBridge = this.deps.deployBridge ?? new DeployBridge({
        cp: {
          ensureProjectRepo: (id) => this.deps.cp.ensureProjectRepo(id),
          getAccount: (id) => this.deps.cp.getAccount(id),
          deploy: (id, opts) => this.deps.cp.deploy(id, opts as any),
        },
      });
    ```
    (Confirm `cp.getAccount` exists — it does, used by `ensureProjectRepo`'s neighbours; if the method name differs, use the actual one.)
  - Replace `runBuild` so it captures `buildOk` and gates the bridge:
    ```ts
      async runBuild(input: { projectId: string; plan: DeployPlan; onEvent: OrchestratorEventHandler }): Promise<void> {
        const { projectId, plan, onEvent } = input;
        const res = await this.claudeFleet.build({ projectId, plan, onEvent: (e) => this.persistAndForward(projectId, e, onEvent) });
        if (!res?.buildOk || !fleetConfig().autodeploy) return;
        const project = await this.deps.cp.getProject(projectId);
        if (!project || project.accountId !== ownerAccountId()) return; // owner-account only in v1
        const root = this.deps.fleet?.workspaceRoot ?? process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects";
        await this.deployBridge.publish({ projectId, workspaceDir: workspaceDir(root, projectId), onEvent: (e) => this.persistAndForward(projectId, e, onEvent) });
      }
    ```
    (If `runBuild` already destructures differently or `claudeFleet.build` was called without using its return, adjust to capture the return. The fleet's `build` now returns `{buildOk}` per Task 2.)

- [ ] **Step 4: Run** `npx tsx --test src/agents/project-orchestrator.fleet.test.ts` → ALL pass. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/project-orchestrator.ts src/agents/project-orchestrator.fleet.test.ts
git commit -m "feat(fleet): auto-deploy on successful build (FLEET_AUTODEPLOY, owner-account)"
```

---

## Task 5: Full suite + typecheck

- [ ] **Step 1:** `npx tsx --test src/agents/*.test.ts src/fleet/**/*.test.ts src/fleet/*.test.ts` → all PASS.
- [ ] **Step 2:** `npm run typecheck` → clean.
- [ ] **Step 3:** Commit any fixes: `git add -A && git commit -m "test(phase4): full suite green"`.

---

## Self-Review notes (author)
- **Spec coverage:** config flag (T1), build-success sentinel + `{buildOk}` (T2), DeployBridge ensure-repo→writeFile→deploy + repo-less degrade (T3), orchestrator gate buildOk+autodeploy+owner (T4), suite (T5). Bridge reuses `ensureProjectRepo`/`gitProviderFor`/`repoRefFor`/`writeFile`/`deploy` — no new prod path.
- **Deferred per spec:** tenant auto-deploy, bulk tree push, custom domains, auto-rollback — no task, intentional.
- **Type consistency:** `BridgeResult`/`BridgeCp`/`DeployBridgeDeps` in deploy-bridge.ts; `{buildOk}` returned by `ClaudeFleet.build` (T2) consumed in `ProjectOrchestrator.runBuild` (T4); `autodeploy` on `FleetConfig` (T1) read in T4.
- **Controlled notes:** confirm the `DeployTrigger` literal (`"auto"`) against the real `deploy` type; confirm `cp.getAccount`/`cp.getProject`/`cp.ensureProjectRepo`/`cp.deploy` method names exist on `ControlPlane` (they do per `control-plane.ts`); the bridge defaults to `gitProviderFor`/`repoRefFor` with `as any` to bridge the `ProjectLike`/`AccountLike` shapes.

# Phase 2 — Self-Healing Deploys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the ops brain with a `RemediationAgent` that, on a failed deploy, runs a bounded Claude Code session (Phase 1 SDK) to diagnose + prepare a fix in the project workspace — governed by the existing propose→gate→verify→learn loop (safe/prepare-only auto-applies at high confidence; redeploy stays gated).

**Architecture:** New `src/fleet/remediation.ts` (`ClaudeRemediator`, reuses Phase 1 `sdk.ts`/`event-map`/`workspace.ts`/`config.ts`/`roster/agent-defs.ts`) + new `src/agents/remediation-agent.ts` (implements the `Agent` interface). Tiny edits to `src/agents/types.ts` (add `"remediation"` to `AgentName`) and `src/agents/index.ts` (register the agent). No change to `brain.ts`, the gate, or the learning loop.

**Tech Stack:** TypeScript (CommonJS), `@anthropic-ai/claude-agent-sdk`, `tsx`, `node:test`. Worktree: `cantila-control-plane/.claude/worktrees/fleet-build-engine` on branch `feat/fleet-self-heal-deploys`.

## Conventions
- Tests: `node:test` + `node:assert/strict`, colocated `*.test.ts`, run `npx tsx --test <file>`.
- The SDK `query` is ALWAYS injected as `QueryFn` (from `src/fleet/sdk.ts`) so tests pass a fake async generator — never call the real API in a test.
- Success signal: the remediation prompt instructs the session to end with a line `REMEDIATION_RESULT: ok` (build/typecheck passed after fix) or `REMEDIATION_RESULT: failed`. `ClaudeRemediator` parses that sentinel deterministically.
- Commit after each task on branch `feat/fleet-self-heal-deploys`.

## File Structure
```
src/fleet/remediation.ts         # NEW — ClaudeRemediator (bounded diagnose+fix session)
src/fleet/remediation.test.ts    # NEW
src/agents/remediation-agent.ts  # NEW — RemediationAgent (Agent interface)
src/agents/remediation-agent.test.ts  # NEW
src/agents/types.ts              # EDIT — add "remediation" to AgentName
src/agents/index.ts              # EDIT — register RemediationAgent
```

---

## Task 1: Add `"remediation"` to `AgentName`

**Files:** Modify `src/agents/types.ts`; Test `src/agents/remediation-name.test.ts`.

- [ ] **Step 1: Write the failing test** `src/agents/remediation-name.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentName } from "./types";

test("remediation is a valid AgentName", () => {
  const n: AgentName = "remediation";
  assert.equal(n, "remediation");
});
```

- [ ] **Step 2: Run** `npx tsx --test src/agents/remediation-name.test.ts` → FAIL (type error: "remediation" not assignable to AgentName). Note: tsx may run it (type errors don't always stop tsx); the real gate is `npm run typecheck` in step 4 failing before the edit. Run `npm run typecheck` and confirm it errors on this file.

- [ ] **Step 3: Edit `src/agents/types.ts`** — add `"remediation"` to the `AgentName` union:
```ts
export type AgentName =
  | "uptime"
  | "deploy"
  | "cost"
  | "scale"
  | "security"
  | "capacity"
  | "mail"
  | "sms"
  | "automation"
  | "seo"
  | "remediation";
```

- [ ] **Step 4: Run** `npm run typecheck` → clean. `npx tsx --test src/agents/remediation-name.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/agents/types.ts src/agents/remediation-name.test.ts
git commit -m "feat(agents): add remediation to AgentName"
```

---

## Task 2: `ClaudeRemediator` (bounded diagnose+fix session)

**Files:** Create `src/fleet/remediation.ts`; Test `src/fleet/remediation.test.ts`.

**Context:** Reuses `src/fleet/sdk.ts` (`QueryFn`), `src/fleet/workspace.ts` (`workspaceDir`), `src/fleet/roster/agent-defs.ts` (`agentDefinitions`), `src/fleet/config.ts` (`fleetConfig`). Mirrors the option-shape used by Phase 1's `ClaudeFleet`.

- [ ] **Step 1: Write the failing test** `src/fleet/remediation.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeRemediator } from "./remediation";

const deployment = { id: "dpl_1", status: "failed", createdAt: new Date(0).toISOString(), logs: ["npm ci", "next build", "Error: Module not found: './missing'"] };

function fakeQuery(cap, transcript) {
  return async function* ({ options }) {
    cap.options = options;
    for (const m of transcript) yield m;
  };
}
function asst(text) { return { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }; }
function toolUse(name) { return { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t" + Math.random(), name, input: { file_path: "x" } }] } }; }
function result() { return { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.02 }; }

test("ok=true when a file changed and the success sentinel is present; passes safe options", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const cap = {};
  const transcript = [asst("Diagnosing the failed build."), toolUse("Edit"), asst("Fixed the import. REMEDIATION_RESULT: ok"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery(cap, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, true);
  assert.ok(out.filesChanged >= 1);
  assert.match(out.diagnosis, /Diagnosing|Fixed/);
  assert.equal(cap.options.permissionMode, "dontAsk");
  assert.equal(cap.options.cwd, path.resolve(root, "p1", "workspace"));
  assert.ok(Array.isArray(cap.options.disallowedTools) && cap.options.disallowedTools.length > 0);
  assert.ok(cap.options.maxBudgetUsd > 0 && cap.options.maxTurns >= 1);
});

test("ok=false when the failed sentinel is present", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const transcript = [asst("Tried, but build still fails. REMEDIATION_RESULT: failed"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery({}, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
});

test("ok=false when no sentinel is present (conservative)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const transcript = [asst("I changed a file."), toolUse("Write"), result()];
  const r = new ClaudeRemediator({ query: fakeQuery({}, transcript), workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
});

test("offline (null query) returns ok=false with an offline message", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const r = new ClaudeRemediator({ query: null, workspaceRoot: root });
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
  assert.match(out.detail, /offline|ANTHROPIC/i);
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/remediation.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement** `src/fleet/remediation.ts`:
```ts
import { mkdir } from "node:fs/promises";
import type { QueryFn } from "./sdk";
import { workspaceDir } from "./workspace";
import { agentDefinitions } from "./roster/agent-defs";
import { fleetConfig } from "./config";
import type { OrchestratorEvent } from "../agents/project-orchestrator";

const DISALLOWED = [
  "Bash(rm:*)", "Bash(sudo:*)", "Bash(mv:*)", "Bash(chmod:*)",
  "Bash(git push:*)", "Bash(git clone:*)", "Bash(git reset:*)",
  "Bash(curl:*)", "Bash(wget:*)",
];
const ALLOWED = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"];

export interface DeploymentLike {
  id: string;
  status: string;
  createdAt: string;
  logs: string[];
}

export interface RemediationResult {
  ok: boolean;
  detail: string;
  filesChanged: number;
  diagnosis: string;
}

export interface ClaudeRemediatorDeps {
  query: QueryFn | null;
  workspaceRoot: string;
  /** Optional event sink (e.g. to stream into the org chart / brain log). */
  onEvent?: (e: OrchestratorEvent) => void;
}

export class ClaudeRemediator {
  constructor(private deps: ClaudeRemediatorDeps) {}

  async remediate(input: { projectId: string; deployment: DeploymentLike }): Promise<RemediationResult> {
    if (!this.deps.query) {
      return { ok: false, detail: "remediation offline — ANTHROPIC_API_KEY not set", filesChanged: 0, diagnosis: "" };
    }
    const cfg = fleetConfig();
    const cwd = workspaceDir(this.deps.workspaceRoot, input.projectId);
    await mkdir(cwd, { recursive: true });

    const logs = (input.deployment.logs ?? []).slice(-40).join("\n");
    const prompt =
      `A deployment of this project FAILED. You are 00-orchestrator of Cantila's build fleet. ` +
      `Diagnose the root cause from the build logs below and FIX it in the working directory — real edits, no mock data. ` +
      `Delegate to devops-engineer, the relevant builder (e.g. react-engineer/api-engineer), and qa-engineer via the Agent tool. ` +
      `After fixing, run the project's build or typecheck to confirm it compiles. Do NOT deploy or touch production.\n\n` +
      `--- deployment ${input.deployment.id} logs (tail) ---\n${logs || "(no logs)"}\n--- end logs ---\n\n` +
      `When finished, output a final line EXACTLY one of:\n` +
      `REMEDIATION_RESULT: ok   (you applied a fix AND the build/typecheck passes)\n` +
      `REMEDIATION_RESULT: failed   (otherwise)`;

    let texts = "";
    let filesChanged = 0;
    let errored = false;
    try {
      const stream = this.deps.query({
        prompt,
        options: {
          cwd,
          agents: agentDefinitions(),
          allowedTools: ALLOWED,
          disallowedTools: DISALLOWED,
          permissionMode: "dontAsk",
          maxTurns: cfg.maxAgentSteps * cfg.maxRounds,
          maxBudgetUsd: cfg.maxBudgetUsd,
          model: "opus",
        } as any,
      });
      for await (const msg of stream as any) {
        if (msg?.type === "assistant") {
          for (const b of msg.message?.content ?? []) {
            if (b.type === "text" && b.text) texts += " " + b.text;
            if (b.type === "tool_use" && (b.name === "Write" || b.name === "Edit")) filesChanged++;
          }
          this.deps.onEvent?.({ kind: "agent_message", agent: "remediation", content: "(remediating)" });
        } else if (msg?.type === "result" && msg.is_error) {
          errored = true;
        }
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "remediation session failed", filesChanged, diagnosis: texts.trim().slice(0, 1000) };
    }

    const sentinelOk = /REMEDIATION_RESULT:\s*ok\b/i.test(texts);
    const sentinelFail = /REMEDIATION_RESULT:\s*failed\b/i.test(texts);
    const ok = sentinelOk && !sentinelFail && !errored && filesChanged >= 1;
    const detail = ok
      ? `prepared a fix (${filesChanged} file change(s)); build/typecheck passed in-session`
      : sentinelFail
      ? `could not produce a passing fix (${filesChanged} file change(s))`
      : `no confirmed fix (${filesChanged} file change(s), no success sentinel)`;
    return { ok, detail, filesChanged, diagnosis: texts.trim().slice(0, 1000) };
  }
}
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/remediation.test.ts` → PASS (4 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/remediation.ts src/fleet/remediation.test.ts
git commit -m "feat(fleet): ClaudeRemediator — bounded diagnose+fix session"
```

---

## Task 3: `RemediationAgent` (the gated executor)

**Files:** Create `src/agents/remediation-agent.ts`; Test `src/agents/remediation-agent.test.ts`.

**Context:** Implements `Agent` from `./types` (`name`, `observe(cp)`, `propose(cp)`). Uses `cp.listProjects(accountId)` → `{id,name}[]` and `cp.listProjectDeployments(projectId)` → `DeploymentLike[]`. Helpers: `ownerAccountId()` from `../lib/owner-account`, `now`/`id` from `../lib/ids`. The proposal's `execute(cp)` calls the injected `ClaudeRemediator`.

- [ ] **Step 1: Write the failing test** `src/agents/remediation-agent.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RemediationAgent } from "./remediation-agent";

const failed = { id: "dpl_f", status: "failed", createdAt: new Date().toISOString(), logs: ["next build", "Error: boom"] };
const live = { id: "dpl_ok", status: "live", createdAt: new Date(Date.now() - 1000).toISOString(), logs: [] };

function cpWith(deploys) {
  return {
    listProjects: async () => [{ id: "p1", name: "shop" }],
    listProjectDeployments: async () => deploys,
  };
}
// A remediator stub so the agent test doesn't run a real/fake SDK session.
function remediatorStub(ok) {
  return { remediate: async () => ({ ok, detail: "stub", filesChanged: ok ? 1 : 0, diagnosis: "d" }) };
}

test("proposes one high+safe claude_code_fix for a newly failed deploy", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const proposals = await agent.propose(cpWith([live, failed]));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "claude_code_fix");
  assert.equal(proposals[0].confidence, "high");
  assert.equal(proposals[0].actionClass, "safe");
  assert.equal(proposals[0].agent, "remediation");
  assert.equal(proposals[0].projectId, "p1");
});

test("dedupes: same failed deployment is not re-proposed on a second tick", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  await agent.propose(cpWith([failed]));
  const second = await agent.propose(cpWith([failed]));
  assert.equal(second.length, 0);
});

test("no failed deploys → no proposals", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const proposals = await agent.propose(cpWith([live]));
  assert.equal(proposals.length, 0);
});

test("execute runs the remediator and returns its ok", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(false), accountId: "acc" });
  const [p] = await agent.propose(cpWith([failed]));
  const res = await p.execute({} as any);
  assert.equal(res.ok, false);
  assert.match(res.detail, /stub|fix|confirmed|could not/i);
});

test("observe emits a remediation observation for a failed deploy", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const obs = await agent.observe(cpWith([failed]));
  assert.ok(obs.some((o) => o.agent === "remediation"));
});
```

- [ ] **Step 2: Run** `npx tsx --test src/agents/remediation-agent.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement** `src/agents/remediation-agent.ts`:
```ts
import type { ControlPlane } from "../core/control-plane";
import { id as makeId, now } from "../lib/ids";
import type { Agent, Observation, Proposal } from "./types";
import { ownerAccountId } from "../lib/owner-account";
import type { DeploymentLike, RemediationResult } from "../fleet/remediation";

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minimal remediator surface (the real one is fleet/remediation.ClaudeRemediator). */
export interface Remediator {
  remediate(input: { projectId: string; deployment: DeploymentLike }): Promise<RemediationResult>;
}

export interface RemediationAgentDeps {
  remediator: Remediator;
  /** Owner account to scan. Defaults to ownerAccountId(). */
  accountId?: string;
}

export class RemediationAgent implements Agent {
  readonly name = "remediation" as const;
  private readonly account: string;
  /** Deployment ids already remediated this process — prevents re-proposing
   *  (and re-running an expensive session) for the same failure each tick. */
  private addressed = new Set<string>();

  constructor(private deps: RemediationAgentDeps) {
    this.account = deps.accountId ?? ownerAccountId();
  }

  private async recentFailures(cp: ControlPlane): Promise<Array<{ projectId: string; projectName: string; deployment: DeploymentLike }>> {
    const projects = await cp.listProjects(this.account);
    const since = Date.now() - RECENT_WINDOW_MS;
    const out: Array<{ projectId: string; projectName: string; deployment: DeploymentLike }> = [];
    for (const project of projects) {
      const deploys = (await cp.listProjectDeployments(project.id)) as unknown as DeploymentLike[];
      const lastFailed = deploys
        .slice().reverse()
        .find((d) => d.status === "failed" && new Date(d.createdAt).getTime() >= since);
      if (lastFailed) out.push({ projectId: project.id, projectName: project.name, deployment: lastFailed });
    }
    return out;
  }

  async observe(cp: ControlPlane): Promise<Observation[]> {
    const fails = await this.recentFailures(cp);
    return fails.map((f) => ({
      at: now(),
      agent: this.name,
      kind: "deploy_failed_remediation",
      detail: `${f.projectName} · deployment ${f.deployment.id} failed — remediation candidate`,
      projectId: f.projectId,
    }));
  }

  async propose(cp: ControlPlane): Promise<Proposal[]> {
    const fails = await this.recentFailures(cp);
    const out: Proposal[] = [];
    for (const f of fails) {
      if (this.addressed.has(f.deployment.id)) continue;
      this.addressed.add(f.deployment.id);
      const deployment = f.deployment;
      const projectId = f.projectId;
      out.push({
        id: `prop_remediate_${deployment.id}`,
        at: now(),
        agent: this.name,
        kind: "claude_code_fix",
        title: `${f.projectName}: auto-diagnose + prepare a fix`,
        body: `Deployment ${deployment.id} failed. A bounded Claude Code session will diagnose the logs, fix the project workspace, and confirm it builds. The fix is prepared only — redeploying stays a separate, human-approved step.`,
        confidence: "high",
        actionClass: "safe",
        projectId,
        hints: [{ label: "Inspect", hint: `cantila troubleshoot ${projectId} ${deployment.id}` }],
        execute: async (_cp: ControlPlane) => {
          const r = await this.deps.remediator.remediate({ projectId, deployment });
          return { ok: r.ok, detail: r.detail };
        },
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run** `npx tsx --test src/agents/remediation-agent.test.ts` → PASS (5 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/remediation-agent.ts src/agents/remediation-agent.test.ts
git commit -m "feat(agents): RemediationAgent — gated Claude Code deploy fixer"
```

---

## Task 4: Register `RemediationAgent` in the brain

**Files:** Modify `src/agents/index.ts`; Test `src/agents/index.remediation.test.ts`.

**Context:** `createDefaultBrain(cp)` builds the agent list. Add the remediation agent, constructing a `ClaudeRemediator` with `loadQuery()` + the env workspace root.

- [ ] **Step 1: Write the failing test** `src/agents/index.remediation.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultBrain } from "./index";

test("default brain includes a remediation agent", () => {
  const brain = createDefaultBrain({} as any);
  // AgentBrain stores agents privately; assert via the snapshot's agentStats keys
  // after a no-op — simplest: check the constructed brain exposes the agent names.
  const names = (brain as any).agents.map((a: any) => a.name);
  assert.ok(names.includes("remediation"), `agents: ${names.join(",")}`);
});
```
(Note: `AgentBrain` holds `private agents: Agent[]` — the test reads it via `as any`. If the field name differs, read the actual private field; confirm by reading `src/agents/brain.ts`.)

- [ ] **Step 2: Run** `npx tsx --test src/agents/index.remediation.test.ts` → FAIL (remediation not in list).

- [ ] **Step 3: Edit `src/agents/index.ts`:**

3a. Add imports:
```ts
import { RemediationAgent } from "./remediation-agent";
import { ClaudeRemediator } from "../fleet/remediation";
import { loadQuery } from "../fleet/sdk";
```
3b. Add the export line near the others:
```ts
export { RemediationAgent } from "./remediation-agent";
```
3c. In `createDefaultBrain`, build the remediator and append the agent to the array:
```ts
export function createDefaultBrain(cp: ControlPlane): AgentBrain {
  const remediator = new ClaudeRemediator({
    query: loadQuery(),
    workspaceRoot: process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects",
  });
  return new AgentBrain(cp, [
    new UptimeAgent(),
    new DeployAgent(),
    new CostAgent(),
    new ScaleAgent(),
    new SecurityAgent(),
    new CapacityAgent(),
    new MailAgent(),
    new SmsAgent(),
    new AutomationAgent(),
    new SeoAgent(),
    new RemediationAgent({ remediator }),
  ]);
}
```

- [ ] **Step 4: Run** `npx tsx --test src/agents/index.remediation.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/index.ts src/agents/index.remediation.test.ts
git commit -m "feat(agents): register RemediationAgent in the default brain"
```

---

## Task 5: Full suite + typecheck

- [ ] **Step 1:** Run the agents + fleet suites:
```bash
npx tsx --test src/agents/*.test.ts src/fleet/**/*.test.ts src/fleet/*.test.ts
```
Expected: all PASS.

- [ ] **Step 2:** `npm run typecheck` → clean.

- [ ] **Step 3:** Commit any fixes:
```bash
git add -A && git commit -m "test(phase2): full suite green"
```

---

## Self-Review notes (author)
- **Spec coverage:** AgentName edit (T1), ClaudeRemediator with bounded safe options + sentinel-based ok + offline + conservative-no-sentinel (T2), RemediationAgent high+safe proposal + dedupe + execute→ok + observe (T3), registration in createDefaultBrain (T4), suite (T5). Gate/learning loop untouched (no task changes brain.ts) — correct per spec.
- **Deferred per spec:** auto-redeploy, GitHub PRs, runtime/self-platform healing, async-job refactor — no task, intentional.
- **Type consistency:** `RemediationResult`/`DeploymentLike` defined once in `fleet/remediation.ts` and imported by the agent; `Remediator` interface in the agent matches `ClaudeRemediator.remediate`'s signature; `Agent`/`Proposal`/`Observation` from `agents/types.ts`; `QueryFn` from `fleet/sdk.ts`.
- **Controlled note:** T4's test reads `AgentBrain`'s private `agents` field via `as any` — the implementer confirms the field name in `brain.ts` (it is `private agents: Agent[]`).

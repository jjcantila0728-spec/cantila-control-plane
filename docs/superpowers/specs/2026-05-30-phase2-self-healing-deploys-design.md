# Phase 2 — Self-Healing Deploys (Claude Code remediation as a gated brain executor) — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) → ready for implementation plan
**Part of:** the Cantila agent-organization north-star (memory `project_cantila_agent_org`). Builds on Phase 1 (Claude Code fleet engine).

## 1. Goal

When a deploy fails, the ops **brain** dispatches a **bounded Claude Code session** that reads the deploy logs + the project workspace, diagnoses the cause, and **prepares a fix** in the workspace — flowing through the *existing* propose → gate → verify → learn machinery, surfaced on `/agents`. Safe high-confidence remediation auto-applies (prepare the fix; touches nothing live); anything that mutates running prod stays human-gated.

## 2. Decisions (locked in brainstorming)

- **Extend the brain, don't rewrite it.** Claude Code becomes a new *gated executor* — a `RemediationAgent` plugged into the existing `AgentBrain`. The 9 rule-based agents and the gate/learning code are unchanged.
- **First target: failed deploys.**
- **Autonomy: auto-apply safe, gate destructive.** "Safe" = diagnose + write corrected files into the project workspace (no live mutation) → eligible for auto-apply at high confidence. "Destructive" = redeploy/mutate running prod → always queued. Earned promotion later via the learning loop.

## 3. How it fits the existing brain (read first)

`src/agents/brain.ts` ticks every 60s. Each `Agent` (`src/agents/types.ts`) implements `observe(cp)` + `propose(cp)` and returns `Proposal`s with `confidence`, `actionClass: safe|destructive`, an `execute(cp)` closure, optional `verify(cp)`. The gate auto-applies only **`high + safe`**; everything else queues. The learning loop groups outcomes by `(agent, kind)` and **downgrades** a kind below 50% success over ≥3 tries — knocking it out of auto-apply. `createDefaultBrain` (`src/agents/index.ts`) wires the agent list. The existing `DeployAgent` already detects failed deploys and emits a **queued no-op** `failed_deploy_review` proposal; Phase 2 adds a *sibling* that actually fixes.

## 4. Architecture

New code: `src/agents/remediation-agent.ts` and `src/fleet/remediation.ts`. One small edit to `src/agents/types.ts` (`AgentName`) and `src/agents/index.ts` (register the agent). **No change to brain.ts, the gate, or the learning loop.** Reuses Phase 1's `src/fleet/{sdk,event-map,session-registry,workspace,config,roster/agent-defs}`.

### 4.1 `RemediationAgent` (`src/agents/remediation-agent.ts`)
- `name: "remediation"`.
- `observe(cp)`: emit a `deploy_failed_remediation` observation per newly-seen failed deployment (informational).
- `propose(cp)`: for each **new** failed deployment (deduped by `deploymentId` via an in-memory `Set` on the instance — resets on restart, which is safe because remediation only prepares a branch), emit ONE proposal:
  - `kind: "claude_code_fix"`, `confidence: "high"`, `actionClass: "safe"` (preparing a fix touches nothing live), `projectId`.
  - `hints`: the existing `cantila troubleshoot <proj> <dep>` + (if a prior live deploy exists) `cantila rollback …`.
  - `execute(cp)`: calls `ClaudeRemediator.remediate(...)` with the project + the failed deployment (closure captures `deployment.logs`); returns `{ ok, detail }` where `ok` reflects whether the session prepared a fix **that passes an in-session build/typecheck**. A failing build → `ok: false` → the learning loop counts it, and a `claude_code_fix` kind that keeps failing gets auto-downgraded out of auto-apply (starts queuing for a human).
  - No separate `verify` closure in v1 (the in-session build check is the success signal; `verified: "n/a"`). Redeploying the prepared fix is intentionally **not** part of this proposal — that's a later, gated step.
- Dedupe + cost: only newly-seen failures propose; sessions are bounded by `maxBudgetUsd`/`maxTurns`. A failed deploy that's already been remediated is not re-proposed unless the agent instance restarts.

### 4.2 `ClaudeRemediator` (`src/fleet/remediation.ts`)
- `remediate({ projectId, deployment, workspaceRoot, query, registry, onEvent? }): Promise<RemediationResult>` where `RemediationResult = { ok: boolean; detail: string; filesChanged: number; diagnosis: string }`.
- Reuses Phase 1: `workspaceDir(workspaceRoot, projectId)` as `cwd`; `agentDefinitions()` for subagents; `mapSdkMessage` to stream into the brain/org chart; `fleetConfig()` caps; `loadQuery()` injected (testable).
- Prompt: a remediation system instruction — "A deployment failed. Here are the logs: <logs>. Diagnose the root cause, fix it in the working directory (no mock data), and run the project's build/typecheck to confirm the fix compiles. Delegate to devops-engineer / the relevant builder / qa-engineer. Do NOT deploy or touch production." Options: `cwd`, `permissionMode: "dontAsk"`, the Phase-1 destructive-bash deny-list, `maxTurns`/`maxBudgetUsd`, `model: "opus"`.
- Determines `ok`: parses the session result — `ok: true` only if the session reports the build/typecheck passed after the edit and ≥1 file changed; else `false`. (Heuristic: scan the final result text + tool outcomes for a successful build step; conservative — unknown ⇒ `false`.)
- Missing/empty workspace (project not fleet-built): degrade gracefully — diagnose from logs only, `filesChanged: 0`, `ok: false`, detail explains no workspace to fix. Never throws into the brain.
- Offline (`query === null`): return `{ ok: false, detail: "remediation offline — ANTHROPIC_API_KEY not set", filesChanged: 0, diagnosis: "" }`.

### 4.3 Wiring
- `src/agents/types.ts`: add `"remediation"` to the `AgentName` union.
- `src/agents/index.ts`: `createDefaultBrain` constructs `new RemediationAgent({ query: loadQuery(), workspaceRoot: process.env.FLEET_WORKSPACE_ROOT ?? "runtime/projects", registry })` and appends it to the agent list. The shared `FleetSessionRegistry` is the one already created for the orchestrator (so the org chart reflects remediation activity); pass it in, or create one if absent.

### 4.4 Safety
- The remediation session is sandboxed to the project `cwd`, `permissionMode: "dontAsk"`, destructive-bash deny-list, budget/turn caps — it **cannot touch prod infra**; it only edits the workspace and returns a result. The brain's gate governs any prod action (none auto, in v1).
- Gate + learning loop **unchanged**: only `high + safe` auto-applies; a remediation kind that keeps failing its in-session build check is auto-downgraded to queuing.
- Security-division subagents remain authorized/defensive-only (Phase 1 preamble).
- Long `execute` (a session can take minutes) is awaited inside a tick; the brain's existing `ticking` guard prevents overlapping ticks. Acceptable for v1; moving remediation to an async job is a later enhancement (noted).

## 5. Data flow

deploy fails → brain tick → `RemediationAgent.propose` emits `claude_code_fix` (high+safe) → gate auto-applies → `execute` runs `ClaudeRemediator` → bounded Claude Code session over logs+workspace diagnoses + edits + build-checks → `{ok}` recorded in the action journal (streamed to `/agents`; org chart shows devops/builder/qa working) → learning loop tracks `(remediation, claude_code_fix)` success; repeated build failures downgrade it to human-queued.

## 6. Files

```
src/agents/remediation-agent.ts        # NEW — the gated executor agent
src/agents/remediation-agent.test.ts   # NEW
src/fleet/remediation.ts               # NEW — ClaudeRemediator (bounded session)
src/fleet/remediation.test.ts          # NEW
src/agents/types.ts                    # EDIT — add "remediation" to AgentName
src/agents/index.ts                    # EDIT — register RemediationAgent in createDefaultBrain
```

## 7. Testing (TDD)

- **RemediationAgent**: with a fake `ControlPlane` returning one failed deployment, `propose` emits exactly one `claude_code_fix` (high+safe) proposal; a second tick for the same deploymentId emits none (dedupe); no failed deploys → no proposals.
- **ClaudeRemediator**: injected fake `query` (async generator) → returns `{ok, detail, filesChanged, diagnosis}`; asserts bounded options (`cwd`, `permissionMode:"dontAsk"`, deny-list, caps); offline (`query=null`) → `ok:false` with the offline message; build-failure transcript → `ok:false`; build-success + file write → `ok:true`.
- **execute → outcome**: the proposal's `execute` returns the remediator's `ok`; a `false` result is recorded as `outcome:"failed"` (verified via a brain-level test seam or by calling execute directly).
- **types/registry**: `createDefaultBrain` includes the remediation agent; `AgentName` accepts `"remediation"`.

## 8. Non-goals (later phases)

- Auto-redeploy of a prepared fix (stays gated until the learning track record earns it).
- Opening real GitHub PRs for fixes (v1 stages the fix in the workspace).
- Runtime-error / self-platform healing; the 24/7 scheduler; org-wide learning dashboards.

## 9. Risks & mitigations

- **Cost of a session per failed deploy** → dedupe by deploymentId, `maxBudgetUsd`/`maxTurns` caps, learning auto-downgrade if ineffective.
- **Long execute blocks ticks** → `ticking` guard prevents overlap; async-job refactor noted as later work.
- **Wrong/incomplete fixes** → never auto-deployed; in-session build check gates `ok`; failures downgrade the kind; humans see everything in `/agents`.
- **No workspace for non-fleet projects** → graceful logs-only diagnosis, `ok:false`.

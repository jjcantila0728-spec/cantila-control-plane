# Phase 3 — Budget Governor — Design

**Date:** 2026-05-30
**Status:** Approved (brainstorming) → ready for implementation plan
**Part of:** the Cantila agent-organization north-star (memory `project_cantila_agent_org`). Builds on Phase 1 (fleet engine) + Phase 2 (self-healing deploys, now auto-on in prod).

## 1. Goal & motivation

The autonomous brain already ticks 24/7 (`control-plane.ts:1201`) and, with `FLEET_REMEDIATION=auto` live, fires Claude Code remediation sessions on its own. Each session has only a **per-session** `$2` cap — there is **no global ceiling**, and actual `total_cost_usd` is currently discarded. A burst of failures could spend without an aggregate brake.

Phase 3 adds a **BudgetGovernor**: capture real spend from every Claude Code session into a rolling **daily ledger**, and **refuse to start a new session** once today's spend reaches the cap (default **$25/day**, `FLEET_DAILY_BUDGET_USD`). Surfaced on `/agents`. This is the safety brake that makes the already-live autonomy safe.

## 2. Decisions (locked)
- Scope: **budget governor only** (the scheduler + per-(agent,kind) learning loop already exist in prod).
- Cap: **$25/day** default, configurable via `FLEET_DAILY_BUDGET_USD`. **Block** new sessions when reached (graceful degrade), reset at **UTC midnight**.
- Storage: **in-memory** (matches posture). Restart resets the day's tally — a minor under-count, accepted for v1.

## 3. Architecture

New file `src/fleet/budget.ts`. Small edits to `src/fleet/claude-fleet.ts`, `src/fleet/remediation.ts`, `src/fleet/org.ts`. No change to the brain, gate, or learning loop.

### 3.1 `BudgetGovernor` (`src/fleet/budget.ts`)
- In-memory ledger: `{ date: string; spent: number }` where `date = utcDay()` (`new Date().toISOString().slice(0,10)`).
- Cap resolved once per call from `process.env.FLEET_DAILY_BUDGET_USD` (finite & > 0 else default 25) — or an injected cap for tests.
- API:
  - `canSpend(): boolean` — `snapshot().spentUsd < cap` (rolls the date first).
  - `record(costUsd: number): void` — if finite & > 0, add to today's bucket (rolling the date first).
  - `snapshot(): { date: string; spentUsd: number; capUsd: number; remainingUsd: number; blocked: boolean }` — rolls the date, returns rounded values; `blocked = spentUsd >= capUsd`.
  - Date rollover: any accessor first checks `if (ledger.date !== utcDay()) ledger = { date: utcDay(), spent: 0 }`.
- `getBudgetGovernor(): BudgetGovernor` — lazy module singleton (the shared default). Tests construct their own `new BudgetGovernor({ capUsd })`.

### 3.2 Capture + gate in the session engines
- **`ClaudeFleet`** (`run()`): accept an optional `governor` dep (default `getBudgetGovernor()`). At the top of `run()` (after the offline check), if `!governor.canSpend()` → emit `agent_message` "daily Claude budget reached ($X/$Y) — paused until UTC reset" + `done`, and **do not** call `query`. While streaming, on a `result` message with a numeric `total_cost_usd`, call `governor.record(cost)`.
- **`ClaudeRemediator`** (`remediate()`): same — accept optional `governor` (default singleton); if `!governor.canSpend()` return `{ ok: false, detail: "daily Claude budget reached — paused until UTC reset", filesChanged: 0, diagnosis: "" }` without spawning; record `total_cost_usd` from the `result` message.
- The per-session `maxBudgetUsd` cap stays; the governor is the **aggregate** brake on top.

### 3.3 Surface
- `buildAgentOrg` (`src/fleet/org.ts`) adds `budget: getBudgetGovernor().snapshot()` to its returned object (and `AgentOrg` type gains a `budget` field). The console can render "spent today $X / $Y" from it — a trivial one-line follow-up, **not** in this control-plane-only phase.

## 4. Data flow
session about to start (build or remediation) → check `governor.canSpend()` → if blocked, degrade (no spawn) ; else run the Claude Code session → on `result`, `governor.record(total_cost_usd)` → `/v1/agents/org` exposes `budget` snapshot. At UTC midnight the bucket resets; blocked sessions resume.

## 5. Files
```
src/fleet/budget.ts          # NEW — BudgetGovernor + getBudgetGovernor()
src/fleet/budget.test.ts     # NEW
src/fleet/claude-fleet.ts    # EDIT — gate + record (optional governor dep)
src/fleet/remediation.ts     # EDIT — gate + record (optional governor dep)
src/fleet/org.ts             # EDIT — include budget snapshot in AgentOrg
```

## 6. Testing (TDD)
- **BudgetGovernor**: `canSpend` true under cap / false at-or-over; `record` accumulates and ignores NaN/negative; date rollover resets the bucket (inject a clock or set the internal date to force rollover); `snapshot` shape + `blocked` flag; env cap parsing (default 25, bad value → 25).
- **ClaudeFleet**: injected governor already over cap → `build` emits a budget message + `done`, the fake `query` is **never called** (assert via a call counter); under cap → query runs and the result's `total_cost_usd` is recorded (governor.snapshot().spentUsd increased).
- **ClaudeRemediator**: over cap → `ok:false` budget message, query not called; under cap → records cost.
- **org**: `buildAgentOrg` output includes a `budget` object with `capUsd`/`spentUsd`/`blocked`.

## 7. Risks & mitigations
- **Restart resets daily tally** (in-memory) → under-counting after a restart; accepted for v1, durable persistence noted as later work.
- **Shared singleton vs testability** → both engines accept an injected governor; the singleton is only the default.
- **Clock/timezone** → UTC day key is unambiguous and matches typical budget accounting.
- **Blocking autonomy** → graceful degrade messages make it obvious in `/agents`; sessions resume at reset; cap is env-tunable without a deploy-time code change (set `FLEET_DAILY_BUDGET_USD` in Coolify).

## 8. Non-goals (later)
Durable spend persistence; per-project/per-account budgets; the console budget line; org-wide learning upgrades; alerting/notifications on cap.

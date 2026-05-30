# Phase 3 — Budget Governor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `BudgetGovernor` that captures real `total_cost_usd` from every Claude Code session into a daily UTC ledger and refuses to start new sessions once the daily cap (`FLEET_DAILY_BUDGET_USD`, default $25) is reached — surfaced on `/v1/agents/org`.

**Architecture:** New `src/fleet/budget.ts` (`BudgetGovernor` + lazy singleton `getBudgetGovernor()`). `ClaudeFleet` and `ClaudeRemediator` gain an optional injected `governor` (default singleton): they gate (degrade if over cap, no session spawned) and record cost on the `result` message. `buildAgentOrg` exposes the snapshot. No change to the brain/gate/learning loop.

**Tech Stack:** TypeScript (CommonJS), `tsx`, `node:test`. Worktree: `cantila-control-plane/.claude/worktrees/fleet-build-engine` on branch `feat/fleet-budget-governor`.

## Conventions
- Tests: `node:test` + `node:assert/strict`, colocated `*.test.ts`, run `npx tsx --test <file>`.
- The `BudgetGovernor` takes an optional `now: () => Date` (default `() => new Date()`) so date rollover is testable, and an optional `capUsd` so tests don't depend on env.
- Commit after each task on branch `feat/fleet-budget-governor`.

## File Structure
```
src/fleet/budget.ts        # NEW — BudgetGovernor + getBudgetGovernor()
src/fleet/budget.test.ts   # NEW
src/fleet/claude-fleet.ts  # EDIT — gate + record (optional governor dep)
src/fleet/remediation.ts   # EDIT — gate + record (optional governor dep)
src/fleet/org.ts           # EDIT — budget snapshot in AgentOrg
```

---

## Task 1: `BudgetGovernor`

**Files:** Create `src/fleet/budget.ts`; Test `src/fleet/budget.test.ts`.

- [ ] **Step 1: Write the failing test** `src/fleet/budget.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetGovernor, getBudgetGovernor } from "./budget";

test("canSpend true under cap, false at/over cap", () => {
  const g = new BudgetGovernor({ capUsd: 10 });
  assert.equal(g.canSpend(), true);
  g.record(4);
  assert.equal(g.canSpend(), true);
  g.record(6); // total 10 == cap
  assert.equal(g.canSpend(), false);
});

test("record ignores NaN, negative, and non-finite", () => {
  const g = new BudgetGovernor({ capUsd: 10 });
  g.record(Number.NaN);
  g.record(-5);
  g.record(Infinity);
  assert.equal(g.snapshot().spentUsd, 0);
});

test("snapshot shape + blocked flag", () => {
  const g = new BudgetGovernor({ capUsd: 25 });
  g.record(5.5);
  const s = g.snapshot();
  assert.equal(typeof s.date, "string");
  assert.equal(s.capUsd, 25);
  assert.equal(s.spentUsd, 5.5);
  assert.equal(s.remainingUsd, 19.5);
  assert.equal(s.blocked, false);
  g.record(20);
  assert.equal(g.snapshot().blocked, true);
  assert.equal(g.snapshot().remainingUsd, 0); // clamped at 0, not negative
});

test("date rollover resets the daily bucket", () => {
  let day = new Date("2026-05-30T12:00:00Z");
  const g = new BudgetGovernor({ capUsd: 10, now: () => day });
  g.record(8);
  assert.equal(g.snapshot().spentUsd, 8);
  assert.equal(g.canSpend(), true);
  day = new Date("2026-05-31T00:01:00Z"); // next UTC day
  assert.equal(g.snapshot().spentUsd, 0);
  assert.equal(g.canSpend(), true);
});

test("env cap: default 25, bad value falls back to 25", () => {
  const prev = process.env.FLEET_DAILY_BUDGET_USD;
  delete process.env.FLEET_DAILY_BUDGET_USD;
  assert.equal(new BudgetGovernor().snapshot().capUsd, 25);
  process.env.FLEET_DAILY_BUDGET_USD = "50";
  assert.equal(new BudgetGovernor().snapshot().capUsd, 50);
  process.env.FLEET_DAILY_BUDGET_USD = "nonsense";
  assert.equal(new BudgetGovernor().snapshot().capUsd, 25);
  if (prev === undefined) delete process.env.FLEET_DAILY_BUDGET_USD; else process.env.FLEET_DAILY_BUDGET_USD = prev;
});

test("getBudgetGovernor returns a stable singleton", () => {
  assert.equal(getBudgetGovernor(), getBudgetGovernor());
});
```

- [ ] **Step 2: Run** `npx tsx --test src/fleet/budget.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement** `src/fleet/budget.ts`:
```ts
/* Daily spend governor for autonomous Claude Code sessions. In-memory,
   keyed by UTC day; resets at UTC midnight. The aggregate brake on top of
   each session's own maxBudgetUsd. */

export interface BudgetSnapshot {
  date: string;
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  blocked: boolean;
}

export interface BudgetGovernorOpts {
  /** Override the daily cap (USD). Defaults to FLEET_DAILY_BUDGET_USD or 25. */
  capUsd?: number;
  /** Injectable clock for tests. Defaults to () => new Date(). */
  now?: () => Date;
}

function defaultCap(): number {
  const raw = process.env.FLEET_DAILY_BUDGET_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class BudgetGovernor {
  private readonly capUsd: number;
  private readonly now: () => Date;
  private ledger: { date: string; spent: number };

  constructor(opts: BudgetGovernorOpts = {}) {
    this.capUsd = opts.capUsd ?? defaultCap();
    this.now = opts.now ?? (() => new Date());
    this.ledger = { date: this.utcDay(), spent: 0 };
  }

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const today = this.utcDay();
    if (this.ledger.date !== today) this.ledger = { date: today, spent: 0 };
  }

  canSpend(): boolean {
    this.roll();
    return this.ledger.spent < this.capUsd;
  }

  record(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.roll();
    this.ledger.spent += costUsd;
  }

  snapshot(): BudgetSnapshot {
    this.roll();
    const spentUsd = round2(this.ledger.spent);
    return {
      date: this.ledger.date,
      spentUsd,
      capUsd: this.capUsd,
      remainingUsd: round2(Math.max(0, this.capUsd - spentUsd)),
      blocked: spentUsd >= this.capUsd,
    };
  }
}

let singleton: BudgetGovernor | null = null;
/** Shared default governor used by all session engines + the org endpoint. */
export function getBudgetGovernor(): BudgetGovernor {
  if (!singleton) singleton = new BudgetGovernor();
  return singleton;
}
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/budget.test.ts` → PASS (6 tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/budget.ts src/fleet/budget.test.ts
git commit -m "feat(fleet): BudgetGovernor — daily UTC spend ledger + cap"
```

---

## Task 2: Gate + record in `ClaudeFleet`

**Files:** Modify `src/fleet/claude-fleet.ts`; Test: extend `src/fleet/claude-fleet.test.ts`.

**Context:** Read `src/fleet/claude-fleet.ts` first. `ClaudeFleetDeps` is `{ query, workspaceRoot, registry }`. The private `run()` method: (a) returns early with an `agent_message`+`done` when `query` is null (offline); (b) returns early with a message+`done` when `inFlight >= maxConcurrentBuilds` (capacity gate); (c) otherwise streams `this.deps.query(...)` through `mapSdkMessage`. It uses an `emit()` wrapper that dedupes `done`. You will ADD a budget gate mirroring the capacity gate, and record cost in the stream loop.

- [ ] **Step 1: Add failing tests** — append to `src/fleet/claude-fleet.test.ts`:
```ts
import { BudgetGovernor } from "./budget";

test("build is blocked (no query call) when the daily budget is exhausted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  let calls = 0;
  const countingQuery = (async function* () { calls++; })();
  const gov = new BudgetGovernor({ capUsd: 1 });
  gov.record(1); // at cap → blocked
  const events: OrchestratorEvent[] = [];
  const fleet = new ClaudeFleet({ query: (() => countingQuery) as any, workspaceRoot: root, registry: new FleetSessionRegistry(), governor: gov } as any);
  await fleet.build({ projectId: "pb", plan, onEvent: (e) => events.push(e) });
  assert.equal(calls, 0, "query must not be called when over budget");
  assert.ok(events.some((e) => e.kind === "agent_message" && /budget/i.test((e as any).content)));
  assert.equal(events.at(-1)!.kind, "done");
});

test("build records the session cost into the governor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cf-"));
  const gov = new BudgetGovernor({ capUsd: 100 });
  const q = (() => async function* () {
    yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42 };
  })();
  const fleet = new ClaudeFleet({ query: q as any, workspaceRoot: root, registry: new FleetSessionRegistry(), governor: gov } as any);
  await fleet.build({ projectId: "pc", plan, onEvent: () => {} });
  assert.equal(gov.snapshot().spentUsd, 0.42);
});
```
(`plan`, `OrchestratorEvent`, `mkdtempSync`, `tmpdir`, `path`, `FleetSessionRegistry`, `ClaudeFleet` are already imported at the top of this test file from Phase 1.)

- [ ] **Step 2: Run** `npx tsx --test src/fleet/claude-fleet.test.ts` → the two new tests FAIL (governor not honored; `governor` not a recognized dep).

- [ ] **Step 3: Edit `src/fleet/claude-fleet.ts`:**

3a. Add import near the top:
```ts
import { getBudgetGovernor, type BudgetGovernor } from "./budget";
```
3b. Add to `ClaudeFleetDeps`:
```ts
  /** Aggregate daily spend brake. Defaults to the shared singleton. */
  governor?: BudgetGovernor;
```
3c. In `run()`, resolve the governor once near the top (after `const cfg = fleetConfig();`):
```ts
    const governor = this.deps.governor ?? getBudgetGovernor();
```
3d. Add the budget gate immediately AFTER the offline (`if (!this.deps.query)`) block and BEFORE (or right after) the capacity (`inFlight`) gate — mirror the capacity gate's emit+return shape (use the same `emit` wrapper the method already uses for the offline/capacity branches):
```ts
    if (!governor.canSpend()) {
      const s = governor.snapshot();
      emit({ kind: "agent_message", agent: "orchestrator", content: `Daily Claude budget reached ($${s.spentUsd}/$${s.capUsd}) — paused until UTC reset.` });
      emit({ kind: "done" });
      return;
    }
```
(If the offline/capacity branches call `onEvent` directly rather than `emit`, match whatever they use — the goal is: a budget message + exactly one `done`, and NO `query` call. Read the method and stay consistent.)
3e. In the `for await (const msg of stream)` loop, record cost — add at the top of the loop body:
```ts
      if (msg && (msg as any).type === "result" && typeof (msg as any).total_cost_usd === "number") {
        governor.record((msg as any).total_cost_usd);
      }
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/claude-fleet.test.ts` → ALL pass (the prior Phase-1 tests + the 2 new ones). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/claude-fleet.ts src/fleet/claude-fleet.test.ts
git commit -m "feat(fleet): ClaudeFleet honors the daily budget governor"
```

---

## Task 3: Gate + record in `ClaudeRemediator`

**Files:** Modify `src/fleet/remediation.ts`; Test: extend `src/fleet/remediation.test.ts`.

**Context:** Read `src/fleet/remediation.ts`. `ClaudeRemediatorDeps` is `{ query, workspaceRoot, onEvent? }`. `remediate()` returns early `{ ok:false, ... offline ... }` when `query` is null, then streams `this.deps.query(...)`, counts Write/Edit tool_use, accumulates text, handles `result` (sets `errored`), and computes `ok` from the sentinel. You add a budget gate (early return, no spawn) + record cost on `result`.

- [ ] **Step 1: Add failing tests** — append to `src/fleet/remediation.test.ts`:
```ts
import { BudgetGovernor } from "./budget";

test("remediate is blocked (no query call) when over daily budget", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  let calls = 0;
  const gov = new BudgetGovernor({ capUsd: 1 });
  gov.record(1);
  const q = (() => { calls++; return (async function* () {})(); }) as any;
  const r = new ClaudeRemediator({ query: q, workspaceRoot: root, governor: gov } as any);
  const out = await r.remediate({ projectId: "p1", deployment });
  assert.equal(out.ok, false);
  assert.match(out.detail, /budget/i);
  assert.equal(calls, 0);
});

test("remediate records session cost", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rem-"));
  const gov = new BudgetGovernor({ capUsd: 100 });
  const transcript = [{ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }, { type: "text", text: "REMEDIATION_RESULT: ok" }] } }, { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.33 }];
  const q = (() => async function* () { for (const m of transcript) yield m; })();
  const r = new ClaudeRemediator({ query: q as any, workspaceRoot: root, governor: gov } as any);
  await r.remediate({ projectId: "p1", deployment });
  assert.equal(gov.snapshot().spentUsd, 0.33);
});
```
(`deployment`, `mkdtempSync`, `tmpdir`, `path`, `ClaudeRemediator` are already imported at the top of this test file from Phase 2.)

- [ ] **Step 2: Run** `npx tsx --test src/fleet/remediation.test.ts` → the 2 new tests FAIL.

- [ ] **Step 3: Edit `src/fleet/remediation.ts`:**

3a. Add import near the top:
```ts
import { getBudgetGovernor, type BudgetGovernor } from "./budget";
```
3b. Add to `ClaudeRemediatorDeps`:
```ts
  /** Aggregate daily spend brake. Defaults to the shared singleton. */
  governor?: BudgetGovernor;
```
3c. In `remediate()`, AFTER the offline `if (!this.deps.query) { return ... }` block, add the budget gate:
```ts
    const governor = this.deps.governor ?? getBudgetGovernor();
    if (!governor.canSpend()) {
      const s = governor.snapshot();
      return { ok: false, detail: `daily Claude budget reached ($${s.spentUsd}/$${s.capUsd}) — paused until UTC reset`, filesChanged: 0, diagnosis: "" };
    }
```
3d. In the `for await` stream loop, where it already inspects `msg.type === "result"`, record the cost. Add (inside the loop, e.g. in/near the existing `else if (msg?.type === "result" ...)` branch):
```ts
        if (typeof (msg as any).total_cost_usd === "number") governor.record((msg as any).total_cost_usd);
```
(Keep the existing `is_error` handling.)

- [ ] **Step 4: Run** `npx tsx --test src/fleet/remediation.test.ts` → ALL pass. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/remediation.ts src/fleet/remediation.test.ts
git commit -m "feat(fleet): ClaudeRemediator honors the daily budget governor"
```

---

## Task 4: Surface budget in `/v1/agents/org`

**Files:** Modify `src/fleet/org.ts`; Test: extend `src/fleet/org.test.ts`.

**Context:** `buildAgentOrg(registry)` returns `{ divisions, activeBuilds }` (type `AgentOrg`). Add a `budget` field.

- [ ] **Step 1: Add a failing test** — append to `src/fleet/org.test.ts`:
```ts
test("buildAgentOrg includes a budget snapshot", () => {
  const reg = new FleetSessionRegistry();
  const org = buildAgentOrg(reg);
  assert.ok(org.budget, "budget present");
  assert.equal(typeof org.budget.capUsd, "number");
  assert.equal(typeof org.budget.spentUsd, "number");
  assert.equal(typeof org.budget.blocked, "boolean");
});
```
(`buildAgentOrg`, `FleetSessionRegistry` already imported at the top of this test file.)

- [ ] **Step 2: Run** `npx tsx --test src/fleet/org.test.ts` → FAIL (no `budget`).

- [ ] **Step 3: Edit `src/fleet/org.ts`:**
3a. Add import:
```ts
import { getBudgetGovernor, type BudgetSnapshot } from "./budget";
```
3b. Add `budget: BudgetSnapshot;` to the `AgentOrg` interface.
3c. In `buildAgentOrg`, include it in the returned object:
```ts
  return { divisions, activeBuilds: registry.activeBuilds(), budget: getBudgetGovernor().snapshot() };
```

- [ ] **Step 4: Run** `npx tsx --test src/fleet/org.test.ts` → PASS. `npm run typecheck` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/fleet/org.ts src/fleet/org.test.ts
git commit -m "feat(fleet): expose daily budget snapshot on /v1/agents/org"
```

---

## Task 5: Full suite + typecheck

- [ ] **Step 1:** `npx tsx --test src/agents/*.test.ts src/fleet/**/*.test.ts src/fleet/*.test.ts` → all PASS.
- [ ] **Step 2:** `npm run typecheck` → clean.
- [ ] **Step 3:** Commit any fixes: `git add -A && git commit -m "test(phase3): full suite green"`.

---

## Self-Review notes (author)
- **Spec coverage:** BudgetGovernor with canSpend/record/snapshot + UTC rollover + env cap + singleton (T1); ClaudeFleet gate-no-spawn + record (T2); ClaudeRemediator gate-no-spawn + record (T3); `/v1/agents/org` budget field (T4); suite (T5). In-memory + injectable per spec.
- **Deferred per spec:** durable persistence, per-project budgets, console UI line, learning upgrades, alerting — no task, intentional.
- **Type consistency:** `BudgetSnapshot`/`BudgetGovernor`/`BudgetGovernorOpts` defined once in `budget.ts`; `getBudgetGovernor()` singleton reused by ClaudeFleet, ClaudeRemediator, org.ts; `AgentOrg.budget: BudgetSnapshot`.
- **Controlled note:** T2/T3 edits must match the exact existing `emit`/`onEvent` + result-handling shape in claude-fleet.ts / remediation.ts — the implementer reads the file and stays consistent (the snippets show intent + exact added lines).

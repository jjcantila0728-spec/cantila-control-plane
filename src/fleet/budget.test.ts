import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetGovernor, getBudgetGovernor } from "./budget";

test("canSpend true under cap, false at/over cap", () => {
  const g = new BudgetGovernor({ capUsd: 10 });
  assert.equal(g.canSpend(), true);
  g.record(4);
  assert.equal(g.canSpend(), true);
  g.record(6);
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
  assert.equal(g.snapshot().remainingUsd, 0);
});

test("date rollover resets the daily bucket", () => {
  let day = new Date("2026-05-30T12:00:00Z");
  const g = new BudgetGovernor({ capUsd: 10, now: () => day });
  g.record(8);
  assert.equal(g.snapshot().spentUsd, 8);
  assert.equal(g.canSpend(), true);
  day = new Date("2026-05-31T00:01:00Z");
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

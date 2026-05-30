import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetConfig } from "./config";

test("fleetConfig exposes positive caps and a boolean live flag", () => {
  const c = fleetConfig();
  assert.equal(typeof c.live, "boolean");
  assert.ok(c.maxRounds >= 1);
  assert.ok(c.maxAgentSteps >= 1);
  assert.ok(c.maxConcurrency >= 1);
  assert.ok(c.buildTokenBudget > 0);
});

test("fleetConfig reads ANTHROPIC_API_KEY for the live flag", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  assert.equal(fleetConfig().live, true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(fleetConfig().live, false);
  if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
});

test("fleetConfig exposes budget + concurrency caps", () => {
  const c = fleetConfig();
  assert.ok(c.maxBudgetUsd > 0);
  assert.ok(c.maxConcurrentBuilds >= 1);
});

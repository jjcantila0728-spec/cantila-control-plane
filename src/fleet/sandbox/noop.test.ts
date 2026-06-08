import { test } from "node:test";
import assert from "node:assert/strict";
import { NoopSandboxRunner } from "./noop";

test("NoopSandboxRunner passes without running anything", async () => {
  const runner = new NoopSandboxRunner();
  const res = await runner.run({ workspaceDir: "/ws", stack: "next", projectId: "p1" });
  assert.equal(res.passed, true);
  assert.equal(res.skipped, true);
  assert.equal(res.durationMs, 0);
  assert.match(res.detail, /disabled/i);
});

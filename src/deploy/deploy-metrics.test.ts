import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, summariseDeploys } from "./deploy-metrics";

test("classifyFailure buckets by the earliest broken stage", () => {
  assert.equal(classifyFailure(["build-failed:docker-compose unsupported"]), "build_failed");
  assert.equal(classifyFailure(["Module not found: ./lib/x"]), "build_failed");
  assert.equal(classifyFailure(["built", "migrate-failed P2021"]), "migration_failed");
  assert.equal(classifyFailure(["built", "routed", "verify-failed:exited"]), "health_check_failed");
  assert.equal(classifyFailure(["built", "provision-failed db"]), "provision_failed");
  assert.equal(classifyFailure(["something weird"]), "unknown");
  // build precedence over health
  assert.equal(classifyFailure(["build-failed", "verify-failed"]), "build_failed");
});

test("summariseDeploys computes success rate, failure buckets, and per-trigger totals", () => {
  const s = summariseDeploys([
    { status: "live", trigger: "chat", logs: [] },
    { status: "live", trigger: "chat", logs: [] },
    { status: "failed", trigger: "chat", logs: ["build-failed:x"] },
    { status: "failed", trigger: "git", logs: ["verify-failed:crash"] },
    { status: "running", trigger: "chat", logs: [] }, // ignored (in-flight)
  ] as any);
  assert.equal(s.total, 5);
  assert.equal(s.live, 2);
  assert.equal(s.failed, 2);
  assert.equal(s.successRatePct, 50);
  assert.deepEqual(s.byFailureReason, { build_failed: 1, health_check_failed: 1 });
  assert.deepEqual(s.byTrigger.chat, { total: 3, live: 2 });
  assert.deepEqual(s.byTrigger.git, { total: 1, live: 0 });
});

test("summariseDeploys handles an empty set without dividing by zero", () => {
  const s = summariseDeploys([]);
  assert.equal(s.successRatePct, 0);
  assert.equal(s.total, 0);
});

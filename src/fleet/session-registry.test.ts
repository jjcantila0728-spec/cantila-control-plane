import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetSessionRegistry } from "./session-registry";

test("tracks per-agent status + active build count", () => {
  const r = new FleetSessionRegistry();
  assert.equal(r.activeBuilds(), 0);
  r.startBuild("p1");
  assert.equal(r.activeBuilds(), 1);
  r.setAgentStatus("p1", "react-engineer", "working");
  assert.equal(r.statusOf("react-engineer"), "working");
  r.setAgentStatus("p1", "react-engineer", "done");
  r.endBuild("p1");
  assert.equal(r.activeBuilds(), 0);
  assert.equal(r.statusOf("react-engineer"), "done");
});

test("unknown agent is idle", () => {
  const r = new FleetSessionRegistry();
  assert.equal(r.statusOf("nobody"), "idle");
});

test("lastAtOf is set after a status update", () => {
  const r = new FleetSessionRegistry();
  assert.equal(r.lastAtOf("x"), undefined);
  r.setAgentStatus("p1", "x", "working");
  assert.ok(typeof r.lastAtOf("x") === "string");
});

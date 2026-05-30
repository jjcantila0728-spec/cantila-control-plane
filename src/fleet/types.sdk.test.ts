import { test } from "node:test";
import assert from "node:assert/strict";
import { SDK_TOOL_NAMES, AGENT_SESSION_STATUSES } from "./types";

test("SDK tool names cover the slice-1 allow-list", () => {
  for (const t of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent"]) {
    assert.ok(SDK_TOOL_NAMES.includes(t as any), `missing ${t}`);
  }
});

test("agent session statuses are the four lifecycle states", () => {
  assert.deepEqual([...AGENT_SESSION_STATUSES], ["idle", "working", "done", "failed"]);
});

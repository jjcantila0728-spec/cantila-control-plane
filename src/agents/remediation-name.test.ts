import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentName } from "./types";

test("remediation is a valid AgentName", () => {
  const n: AgentName = "remediation";
  assert.equal(n, "remediation");
});

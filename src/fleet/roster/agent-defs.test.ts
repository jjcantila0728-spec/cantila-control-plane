import { test } from "node:test";
import assert from "node:assert/strict";
import { toSdkTools, agentDefinitions } from "./agent-defs";

test("toSdkTools maps AgentFleet tools to SDK tool names", () => {
  assert.deepEqual(toSdkTools(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]).sort(),
    ["Bash", "Edit", "Glob", "Grep", "Read", "Write"].sort());
  assert.ok(toSdkTools(["Task"]).includes("Agent")); // Task -> Agent (delegation)
  assert.deepEqual(toSdkTools(["Bogus"]), []); // unknown dropped
});

test("agentDefinitions yields a record keyed by agent id with prompt/description", () => {
  const defs = agentDefinitions();
  assert.ok(Object.keys(defs).length >= 70);
  const re = defs["react-engineer"];
  assert.ok(re && typeof re.prompt === "string" && re.prompt.length > 0);
  assert.ok(typeof re.description === "string");
  assert.ok(["opus", "sonnet"].includes(re.model as string));
  assert.ok(!defs["00-orchestrator"], "orchestrator is the main agent, not a subagent");
});

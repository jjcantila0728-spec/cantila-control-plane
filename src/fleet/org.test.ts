import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentOrg } from "./org";
import { FleetSessionRegistry } from "./session-registry";

test("buildAgentOrg groups roster by division with live status", () => {
  const reg = new FleetSessionRegistry();
  reg.setAgentStatus("p1", "react-engineer", "working");
  const org = buildAgentOrg(reg);
  assert.ok(org.divisions.length >= 5);
  const fe = org.divisions.find((d) => d.agents.some((a) => a.id === "react-engineer"));
  assert.ok(fe);
  const re = fe!.agents.find((a) => a.id === "react-engineer")!;
  assert.equal(re.status, "working");
  assert.equal(typeof org.activeBuilds, "number");
});

test("agents default to idle status", () => {
  const org = buildAgentOrg(new FleetSessionRegistry());
  const someAgent = org.divisions.flatMap((d) => d.agents)[0];
  assert.equal(someAgent.status, "idle");
});

test("buildAgentOrg includes a budget snapshot", () => {
  const reg = new FleetSessionRegistry();
  const org = buildAgentOrg(reg);
  assert.ok(org.budget, "budget present");
  assert.equal(typeof org.budget.capUsd, "number");
  assert.equal(typeof org.budget.spentUsd, "number");
  assert.equal(typeof org.budget.blocked, "boolean");
});

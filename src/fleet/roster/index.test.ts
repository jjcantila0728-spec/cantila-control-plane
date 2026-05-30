import { test } from "node:test";
import assert from "node:assert/strict";
import { listRoles, getRole, rolesByDivision } from "./index";

test("roster has the full fleet", () => {
  assert.ok(listRoles().length >= 70, `got ${listRoles().length}`);
});
test("orchestrator + key specialists present", () => {
  for (const id of ["00-orchestrator", "react-engineer", "api-engineer", "qa-engineer"]) {
    assert.ok(getRole(id), `missing ${id}`);
  }
});
test("rolesByDivision groups", () => {
  assert.ok(Object.keys(rolesByDivision()).length >= 5);
});

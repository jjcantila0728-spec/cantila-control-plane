import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentRole, HANDOFF_STATUSES } from "./types";

test("isAgentRole accepts a well-formed role", () => {
  assert.equal(
    isAgentRole({
      id: "react-engineer",
      name: "react-engineer",
      division: "frontend",
      description: "builds UI",
      model: "sonnet",
      allowedSkills: ["write_file"],
      systemPrompt: "You are react-engineer.",
    }),
    true,
  );
});

test("isAgentRole rejects a bad model", () => {
  assert.equal(
    isAgentRole({
      id: "x", name: "x", division: "d", description: "",
      model: "haiku", allowedSkills: [], systemPrompt: "p",
    }),
    false,
  );
});

test("handoff statuses are the three contract states", () => {
  assert.deepEqual([...HANDOFF_STATUSES], [
    "pending-review",
    "approved",
    "changes-requested",
  ]);
});

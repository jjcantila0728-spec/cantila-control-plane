import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultBrain } from "./index";

test("default brain includes a remediation agent", () => {
  const brain = createDefaultBrain({} as any);
  const names = (brain as any).agents.map((a: any) => a.name);
  assert.ok(names.includes("remediation"), `agents: ${names.join(",")}`);
});

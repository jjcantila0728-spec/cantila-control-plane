import { test } from "node:test";
import assert from "node:assert/strict";
import { FleetMemory } from "./memory";

test("setDoD + checkDoD toggles items", () => {
  const m = new FleetMemory("proj_1");
  m.setDoD(["app builds", "core flow works"]);
  const read = m.read();
  assert.equal(read.dod.length, 2);
  const firstId = read.dod[0].id;
  m.checkDoD(firstId, true);
  assert.equal(m.read().dod[0].done, true);
  assert.equal(m.allDoDPassed(), false);
});

test("putHandoff stores pending-review; review approves it", () => {
  const m = new FleetMemory("proj_1");
  m.putHandoff({ agent: "react-engineer", round: 1, status: "pending-review", body: "did x" });
  assert.equal(m.read().handoffs["react-engineer"].status, "pending-review");
  m.review("react-engineer", "approved");
  const h = m.read().handoffs["react-engineer"];
  assert.equal(h.status, "approved");
  assert.equal(h.reviewer, "00-orchestrator");
});

test("changes-requested carries feedback and bumps round on re-put", () => {
  const m = new FleetMemory("proj_1");
  m.putHandoff({ agent: "api-engineer", round: 1, status: "pending-review", body: "v1" });
  m.review("api-engineer", "changes-requested", "add validation");
  assert.equal(m.read().handoffs["api-engineer"].status, "changes-requested");
  assert.equal(m.read().handoffs["api-engineer"].feedback, "add validation");
  m.putHandoff({ agent: "api-engineer", round: 2, status: "pending-review", body: "v2" });
  assert.equal(m.read().handoffs["api-engineer"].round, 2);
  assert.equal(m.read().handoffs["api-engineer"].status, "pending-review");
});

test("relevantSlice stays under a size bound", () => {
  const m = new FleetMemory("proj_1");
  m.setProject({ name: "shop", goal: "sell things", stack: "Next.js", status: "building" });
  m.setDoD(["a", "b"]);
  for (let i = 0; i < 50; i++) m.appendDecision(`decision ${i} `.repeat(20));
  const slice = m.relevantSlice("react-engineer");
  assert.ok(slice.length <= 4000, `slice too big: ${slice.length}`);
  assert.match(slice, /shop/);
});

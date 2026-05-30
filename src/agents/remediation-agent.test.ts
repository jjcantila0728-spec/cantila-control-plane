import { test } from "node:test";
import assert from "node:assert/strict";
import { RemediationAgent } from "./remediation-agent";

const failed = { id: "dpl_f", status: "failed", createdAt: new Date().toISOString(), logs: ["next build", "Error: boom"] };
const live = { id: "dpl_ok", status: "live", createdAt: new Date(Date.now() - 1000).toISOString(), logs: [] };

function cpWith(deploys: any[]) {
  return {
    listProjects: async () => [{ id: "p1", name: "shop" }],
    listProjectDeployments: async () => deploys,
  } as any;
}
function remediatorStub(ok: boolean) {
  return { remediate: async () => ({ ok, detail: "stub", filesChanged: ok ? 1 : 0, diagnosis: "d" }) };
}

test("proposes one high+safe claude_code_fix for a newly failed deploy", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const proposals = await agent.propose(cpWith([live, failed]));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "claude_code_fix");
  assert.equal(proposals[0].confidence, "high");
  assert.equal(proposals[0].actionClass, "safe");
  assert.equal(proposals[0].agent, "remediation");
  assert.equal(proposals[0].projectId, "p1");
});

test("dedupes: same failed deployment is not re-proposed on a second tick", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  await agent.propose(cpWith([failed]));
  const second = await agent.propose(cpWith([failed]));
  assert.equal(second.length, 0);
});

test("no failed deploys → no proposals", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const proposals = await agent.propose(cpWith([live]));
  assert.equal(proposals.length, 0);
});

test("execute runs the remediator and returns its ok", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(false), accountId: "acc" });
  const [p] = await agent.propose(cpWith([failed]));
  const res = await p.execute({} as any);
  assert.equal(res.ok, false);
  assert.match(res.detail, /stub|fix|confirmed|could not/i);
});

test("observe emits a remediation observation for a failed deploy", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc" });
  const obs = await agent.observe(cpWith([failed]));
  assert.ok(obs.some((o) => o.agent === "remediation"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { RemediationAgent, remediationMode } from "./remediation-agent";

const failed = { id: "dpl_f", status: "failed", createdAt: new Date().toISOString(), logs: ["next build", "Error: boom"] };
const live = { id: "dpl_ok", status: "live", createdAt: new Date(Date.now() - 1000).toISOString(), logs: [] };

function cpWith(deploys: any[]) {
  return { listProjects: async () => [{ id: "p1", name: "shop" }], listProjectDeployments: async () => deploys } as any;
}
function remediatorStub(ok: boolean) {
  return { remediate: async () => ({ ok, detail: "stub", filesChanged: ok ? 1 : 0, diagnosis: "d" }) };
}

test("auto mode: one high+safe claude_code_fix for a newly failed deploy", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "auto" });
  const proposals = await agent.propose(cpWith([live, failed]));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "claude_code_fix");
  assert.equal(proposals[0].confidence, "high");
  assert.equal(proposals[0].actionClass, "safe");
  assert.equal(proposals[0].agent, "remediation");
  assert.equal(proposals[0].projectId, "p1");
});

test("propose mode (default): proposal is destructive so the gate queues it", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "propose" });
  const [p] = await agent.propose(cpWith([failed]));
  assert.equal(p.actionClass, "destructive");
  assert.equal(p.confidence, "high");
});

test("off mode: no proposals", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "off" });
  const proposals = await agent.propose(cpWith([failed]));
  assert.equal(proposals.length, 0);
});

test("dedupes: same failed deployment is not re-proposed on a second tick", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "auto" });
  await agent.propose(cpWith([failed]));
  const second = await agent.propose(cpWith([failed]));
  assert.equal(second.length, 0);
});

test("no failed deploys → no proposals", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "auto" });
  const proposals = await agent.propose(cpWith([live]));
  assert.equal(proposals.length, 0);
});

test("execute runs the remediator and returns its ok", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(false), accountId: "acc", mode: "auto" });
  const [p] = await agent.propose(cpWith([failed]));
  const res = await p.execute({} as any);
  assert.equal(res.ok, false);
});

test("observe emits a remediation observation for a failed deploy regardless of mode", async () => {
  const agent = new RemediationAgent({ remediator: remediatorStub(true), accountId: "acc", mode: "off" });
  const obs = await agent.observe(cpWith([failed]));
  assert.ok(obs.some((o) => o.agent === "remediation"));
});

test("remediationMode defaults to propose", async () => {
  const prev = process.env.FLEET_REMEDIATION;
  delete process.env.FLEET_REMEDIATION;
  assert.equal(remediationMode(), "propose");
  process.env.FLEET_REMEDIATION = "auto";
  assert.equal(remediationMode(), "auto");
  process.env.FLEET_REMEDIATION = "bogus";
  assert.equal(remediationMode(), "propose");
  if (prev === undefined) delete process.env.FLEET_REMEDIATION; else process.env.FLEET_REMEDIATION = prev;
});

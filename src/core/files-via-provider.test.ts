/* ============================================================
   File methods route through the GitProvider resolver. A
   repo-less project is auto-provisioned (repoHost "cantila")
   and becomes editable via the in-memory stub provider.
   In-memory store + stub provider, fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

function makeCp(): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });
  return { cp, store };
}

test("a repo-less project is auto-provisioned and becomes editable via the stub", async () => {
  const { cp, store } = makeCp();
  await store.createAccount({
    id: "acc_test",
    name: "Cantila",
    handle: "cantila",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  const project = await cp.createProject({
    accountId: "acc_test",
    name: "Homes",
    runtime: "node",
    region: "fsn1",
  });
  assert.ok(!project.repoUrl, "fixture project must start repo-less");

  const write = await cp.writeProjectFile(project.id, { path: "index.html", content: "<h1>hi</h1>" });
  assert.ok(write && "sha" in write);
  const read = await cp.readProjectFile(project.id, "index.html");
  assert.ok(read && "content" in read && read.content === "<h1>hi</h1>");
  const list = await cp.listProjectFiles(project.id);
  assert.ok(list && "files" in list && list.files.some((f) => f.path === "index.html"));
});

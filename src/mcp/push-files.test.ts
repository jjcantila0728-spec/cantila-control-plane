/* ============================================================
   cantila_push_files — commit files into the project's own
   Cantila repo and deploy. Offline: in-memory store + stub
   provider/data-plane, no network.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { cantilaTools } from "./tools";
import type { ToolDefinition, ToolResult } from "./server";

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

function pushTool(cp: ControlPlane): ToolDefinition {
  const tool = cantilaTools(cp).find((t) => t.name === "cantila_push_files");
  assert.ok(tool, "cantila_push_files tool must be registered");
  return tool;
}

function textOf(r: ToolResult): string {
  return r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
}

async function seededProject(cp: ControlPlane, store: InMemoryStore) {
  await store.createAccount({
    id: "acc_test",
    name: "Cantila",
    handle: "cantila",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  return cp.createProject({
    accountId: "acc_test",
    name: "Homes",
    runtime: "node",
    region: "fsn1",
  });
}

test("commits files to the project's cantila repo and deploys", async () => {
  const { cp, store } = makeCp();
  const project = await seededProject(cp, store);
  const res = await pushTool(cp).handler({
    projectId: project.id,
    files: [
      { path: "index.html", content: "<h1>Homes</h1>" },
      { path: "about.html", content: "<p>about</p>" },
    ],
  });
  assert.ok(!res.isError, textOf(res));
  const out = textOf(res);
  assert.match(out, /Committed 2 file\(s\)/);
  assert.match(out, /Deploy live/);

  const list = await cp.listProjectFiles(project.id);
  assert.ok(list && "files" in list);
  const paths = (list as { files: { path: string }[] }).files.map((f) => f.path);
  assert.ok(paths.includes("index.html") && paths.includes("about.html"));

  const deployments = await cp.listProjectDeployments(project.id);
  assert.ok(deployments.length >= 1);
});

/* ============================================================
   bootstrapGit — bootstrap-clone a project's source into Cantila
   git (the backend pulls, no client-side git push) + stack
   detection persisted as buildPack/appPort. In-memory store +
   stub provider, fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "../core/control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";
import { cantilaOrStubProvider } from "../git/resolve";
import type { StubGitProvider } from "../git/stub-provider";

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

async function makeProject(
  cp: ControlPlane,
  store: InMemoryStore,
  name: string,
): Promise<{ id: string; slug: string }> {
  await store
    .createAccount({
      id: "acc_test",
      name: "Cantila",
      handle: "cantila",
      plan: "starter",
      createdAt: new Date().toISOString(),
    })
    .catch(() => undefined); // idempotent across calls in one test file
  const project = await cp.createProject({
    accountId: "acc_test",
    name,
    runtime: "node",
    region: "fsn1",
  });
  return { id: project.id, slug: project.slug };
}

test("bootstrapGit migrates the source server-side and wires the project like connectGit", async () => {
  const { cp, store } = makeCp();
  const { id, slug } = await makeProject(cp, store, "Grit Trade");

  const result = await cp.bootstrapGit(id, {
    sourceUrl: "https://github.com/acme/grit-trade",
  });
  assert.ok(!("error" in result), `unexpected error: ${JSON.stringify(result)}`);
  assert.equal(result.project.repoHost, "cantila");
  assert.ok(result.project.repoUrl && result.project.repoUrl.length > 0);
  assert.equal(result.project.autoDeploy, true);
  assert.equal(result.autoDeployTriggered, true); // bootstrap takes it live by default
  assert.equal(result.webhookSecret.length, 64);
  assert.equal(result.webhookUrl, `/v1/projects/${id}/git/webhook`);
  // The response never carries the secret on the project itself.
  assert.equal(result.project.webhookSecret, undefined);

  // The stub backend recorded WHERE it cloned from — proving the pull
  // happened backend-side, not via a client push.
  const stub = cantilaOrStubProvider() as StubGitProvider;
  assert.equal(
    stub.migrationSource("cantila", slug),
    "https://github.com/acme/grit-trade",
  );
});

test("bootstrapGit detects a backend stack and persists buildPack/appPort", async () => {
  const { cp, store } = makeCp();
  const { id, slug } = await makeProject(cp, store, "Py API");

  // Seed the repo the migrate call will land on (createRepo is idempotent,
  // so the stub keeps these files) — a Python backend.
  const stub = cantilaOrStubProvider() as StubGitProvider;
  await stub.createRepo({ owner: "cantila", name: slug });
  await stub.writeFile(
    { owner: "cantila", repo: slug },
    { path: "requirements.txt", content: "fastapi\nuvicorn", branch: "main" },
  );

  const result = await cp.bootstrapGit(id, {
    sourceUrl: "https://github.com/acme/py-api",
  });
  assert.ok(!("error" in result));
  assert.equal(result.stack.buildPack, "nixpacks");
  assert.equal(result.stack.port, 8000);
  const project = await store.getProject(id);
  assert.equal(project?.buildPack, "nixpacks");
  assert.equal(project?.appPort, 8000);
});

test("bootstrapGit honors a Dockerfile (any stack) including its EXPOSE port", async () => {
  const { cp, store } = makeCp();
  const { id, slug } = await makeProject(cp, store, "Docker App");

  const stub = cantilaOrStubProvider() as StubGitProvider;
  await stub.createRepo({ owner: "cantila", name: slug });
  await stub.writeFile(
    { owner: "cantila", repo: slug },
    { path: "Dockerfile", content: "FROM golang:1.22\nEXPOSE 5000", branch: "main" },
  );

  const result = await cp.bootstrapGit(id, {
    sourceUrl: "https://github.com/acme/docker-app",
  });
  assert.ok(!("error" in result));
  assert.equal(result.stack.buildPack, "dockerfile");
  assert.equal(result.stack.port, 5000);
  const project = await store.getProject(id);
  assert.equal(project?.buildPack, "dockerfile");
  assert.equal(project?.appPort, 5000);
});

test("bootstrapGit with autoDeploy:false wires the repo but does NOT take it live", async () => {
  const { cp, store } = makeCp();
  const { id } = await makeProject(cp, store, "Manual Deploy");
  const result = await cp.bootstrapGit(id, {
    sourceUrl: "https://github.com/acme/manual",
    autoDeploy: false,
  });
  assert.ok(!("error" in result));
  assert.equal(result.autoDeployTriggered, false);
});

test("bootstrapGit rejects a non-https source", async () => {
  const { cp, store } = makeCp();
  const { id } = await makeProject(cp, store, "Bad Source");
  const result = await cp.bootstrapGit(id, { sourceUrl: "git@github.com:a/b.git" });
  assert.ok("error" in result);
});

test("bootstrapGit on an unknown project returns a structured error", async () => {
  const { cp } = makeCp();
  const result = await cp.bootstrapGit("proj_missing", {
    sourceUrl: "https://github.com/acme/x",
  });
  assert.ok("error" in result && result.error === "project not found");
});

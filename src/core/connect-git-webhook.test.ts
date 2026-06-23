/* ============================================================
   connectGit — auto-deploy-from-GitHub wiring. Beyond minting the
   per-project HMAC secret, connect should:
     1. return an ABSOLUTE webhook URL (pasteable straight into a host),
     2. auto-register the push webhook on GitHub when a one-time
        registration token is supplied — degrading to manual on failure.
   In-memory store + injected registrar stub, fully offline.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane, type ControlPlaneDeps } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

type RegisterInput = { repoUrl: string; token: string; webhookUrl: string; secret: string };

function makeCp(
  registrar?: ControlPlaneDeps["githubWebhookRegistrar"],
): { cp: ControlPlane; store: InMemoryStore } {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
    githubWebhookRegistrar: registrar,
  });
  return { cp, store };
}

async function makeProject(cp: ControlPlane, store: InMemoryStore): Promise<string> {
  await store
    .createAccount({
      id: "acc_test",
      name: "Cantila",
      handle: "cantila",
      plan: "starter",
      createdAt: new Date().toISOString(),
    })
    .catch(() => undefined);
  const project = await cp.createProject({
    accountId: "acc_test",
    name: "Site",
    runtime: "node",
    region: "fsn1",
  });
  return project.id;
}

test("connectGit returns an absolute, pasteable webhook URL", async () => {
  const { cp, store } = makeCp();
  const id = await makeProject(cp, store);
  const result = await cp.connectGit(id, { repoUrl: "https://github.com/acme/site" });
  assert.ok(!("error" in result));
  assert.match(
    result.webhookUrl,
    /^https:\/\/[^/]+\/v1\/projects\/.+\/git\/webhook$/,
    `expected absolute URL, got ${result.webhookUrl}`,
  );
});

test("connectGit auto-registers the GitHub webhook when given a registration token", async () => {
  const seen: RegisterInput[] = [];
  const { cp, store } = makeCp({
    register: async (input) => {
      seen.push(input);
      return { hookId: 42 };
    },
  });
  const id = await makeProject(cp, store);
  const result = await cp.connectGit(id, {
    repoUrl: "https://github.com/acme/site",
    registrationToken: "ghp_oneTimeToken",
  });
  assert.ok(!("error" in result));
  assert.equal(result.webhookRegistered, true);
  assert.equal(seen.length, 1, "registrar should be called exactly once");
  // It must hand the registrar the SAME secret + absolute URL it returns,
  // and the one-time token — which is never persisted on the project.
  assert.equal(seen[0].secret, result.webhookSecret);
  assert.equal(seen[0].webhookUrl, result.webhookUrl);
  assert.equal(seen[0].token, "ghp_oneTimeToken");
  const stored = await store.getProject(id);
  assert.equal((stored as { registrationToken?: string }).registrationToken, undefined);
});

test("connectGit degrades to manual when registration fails — connect still succeeds", async () => {
  const { cp, store } = makeCp({
    register: async () => {
      throw new Error("403 admin:repo_hook scope missing");
    },
  });
  const id = await makeProject(cp, store);
  const result = await cp.connectGit(id, {
    repoUrl: "https://github.com/acme/site",
    registrationToken: "ghp_badScope",
  });
  assert.ok(!("error" in result), "connect must not fail because registration did");
  assert.equal(result.webhookRegistered, false);
  assert.match(result.webhookRegistrationError ?? "", /admin:repo_hook/);
  assert.equal(result.project.autoDeploy, true);
  assert.equal(result.webhookSecret.length, 64);
});

test("connectGit does not attempt registration without a token", async () => {
  let called = false;
  const { cp, store } = makeCp({
    register: async () => {
      called = true;
      return { hookId: 1 };
    },
  });
  const id = await makeProject(cp, store);
  const result = await cp.connectGit(id, { repoUrl: "https://github.com/acme/site" });
  assert.ok(!("error" in result));
  assert.equal(called, false);
  assert.equal(result.webhookRegistered, false);
});

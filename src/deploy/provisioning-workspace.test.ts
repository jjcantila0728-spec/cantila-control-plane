import { test } from "node:test";
import assert from "node:assert/strict";

import { provisionProjectServices } from "./provisioning";
import type { ServiceProvisioner, WorkspaceProvisioner } from "./provisioning";
import { InMemoryStore } from "../domain/store";

const baseProvisioner: ServiceProvisioner = {
  async createDatabase() {
    return { engine: "postgres", version: "16", connectionUri: "postgres://x@db:5432/x" };
  },
};

function makeWorkspaceProvisioner(kind: string): WorkspaceProvisioner {
  return {
    async createWorkspace(project, k) {
      return {
        workspaceUrl: `https://${k}-${project.slug}.cantila.app`,
        adminUser: "admin",
        adminEmail: `admin@${k}-${project.slug}.cantila.app`,
        adminPassword: "ws-secret-pw",
        apiKey: "ws-api-key",
      };
    },
  };
}

test("automation project gets a workspace provisioned with its URL injected", async () => {
  const project = {
    id: "prj_n8n",
    slug: "acme",
    name: "Acme Automation",
    region: "eu",
    automationKind: "n8n",
    accountId: "acc_test",
    runtime: "node",
    status: "provisioning",
    alwaysOn: false,
    autoSleep: false,
    autoDeploy: false,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    createdAt: new Date().toISOString(),
  } as any;

  const store = new InMemoryStore();
  await store.createProject(project);
  const result = await provisionProjectServices(
    store,
    baseProvisioner,
    project,
    makeWorkspaceProvisioner("n8n"),
  );

  assert.ok(result.workspaceCreated, "workspaceCreated should be true on first deploy");
  assert.ok(result.injectedEnv.includes("AUTOMATION_WORKSPACE_URL"), "workspace URL injected");
  assert.ok(result.injectedEnv.includes("AUTOMATION_ADMIN_USER"), "workspace admin user injected");
  assert.ok(result.injectedEnv.includes("AUTOMATION_ADMIN_PASSWORD"), "workspace admin password injected");
  assert.ok(result.injectedEnv.includes("AUTOMATION_KIND"), "automation kind injected");

  const env = await store.listEnvVars(project.id);
  const url = env.find((e) => e.key === "AUTOMATION_WORKSPACE_URL");
  assert.equal(url?.value, "https://n8n-acme.cantila.app");
  const kind = env.find((e) => e.key === "AUTOMATION_KIND");
  assert.equal(kind?.value, "n8n");
});

test("openclaw automation project gets its own workspace", async () => {
  const project = {
    id: "prj_oc",
    slug: "myco",
    name: "MyCo OpenClaw",
    region: "eu",
    automationKind: "openclaw",
    accountId: "acc_test",
    runtime: "node",
    status: "provisioning",
    alwaysOn: false,
    autoSleep: false,
    autoDeploy: false,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    createdAt: new Date().toISOString(),
  } as any;

  const store = new InMemoryStore();
  await store.createProject(project);
  const result = await provisionProjectServices(
    store,
    baseProvisioner,
    project,
    makeWorkspaceProvisioner("openclaw"),
  );

  assert.ok(result.workspaceCreated, "workspaceCreated should be true");
  const env = await store.listEnvVars(project.id);
  const url = env.find((e) => e.key === "AUTOMATION_WORKSPACE_URL");
  assert.equal(url?.value, "https://openclaw-myco.cantila.app");
  const kind = env.find((e) => e.key === "AUTOMATION_KIND");
  assert.equal(kind?.value, "openclaw");
});

test("workspace provisioning is idempotent — second deploy skips creation", async () => {
  const project: any = {
    id: "prj_idem",
    slug: "idem",
    name: "Idempotent",
    region: "eu",
    automationKind: "n8n",
    automationConfig: { workspaceUrl: "https://n8n-idem.cantila.app" },
  };

  let callCount = 0;
  const wsProvisioner: WorkspaceProvisioner = {
    async createWorkspace() {
      callCount++;
      return {
        workspaceUrl: "https://n8n-idem.cantila.app",
        adminUser: "admin",
        adminEmail: "admin@n8n-idem.cantila.app",
        adminPassword: "pw",
        apiKey: "ws-api-key",
      };
    },
  };

  const store = new InMemoryStore();
  const result = await provisionProjectServices(store, baseProvisioner, project, wsProvisioner);

  assert.equal(callCount, 0, "createWorkspace must not be called when workspace already exists");
  assert.equal(result.workspaceCreated, false, "workspaceCreated should be false on subsequent deploy");
});

test("regular (non-automation) project does not get a workspace", async () => {
  const project = {
    id: "prj_reg",
    slug: "regular",
    name: "Regular App",
    region: "eu",
  } as any;

  let called = false;
  const wsProvisioner: WorkspaceProvisioner = {
    async createWorkspace() {
      called = true;
      return {
        workspaceUrl: "x",
        adminUser: "x",
        adminEmail: "x",
        adminPassword: "x",
        apiKey: "x",
      };
    },
  };

  const store = new InMemoryStore();
  const result = await provisionProjectServices(store, baseProvisioner, project, wsProvisioner);

  assert.equal(called, false, "createWorkspace must not be called for non-automation projects");
  assert.equal(result.workspaceCreated, false);
  assert.ok(!result.injectedEnv.includes("AUTOMATION_WORKSPACE_URL"));
});

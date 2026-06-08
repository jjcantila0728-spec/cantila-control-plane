import { test } from "node:test";
import assert from "node:assert/strict";

import { provisionProjectServices } from "./provisioning";
import type { ServiceProvisioner } from "./provisioning";
import { InMemoryStore } from "../domain/store";

const project = { id: "prj_1", slug: "acme", name: "Acme", region: "eu" } as any;

const provisioner: ServiceProvisioner = {
  async createDatabase() {
    return { engine: "postgres", version: "16", connectionUri: "postgres://x@db:5432/x" };
  },
};

test("deploy does NOT auto-provision email — no SMTP env vars injected", async () => {
  const store = new InMemoryStore();
  const result = await provisionProjectServices(store, provisioner, project);

  const env = await store.listEnvVars(project.id);
  const smtpKeys = env.map((e) => e.key).filter((k) => k.startsWith("SMTP_") || k === "MAIL_FROM");
  assert.deepEqual(smtpKeys, [], "no SMTP/MAIL_FROM env vars should be injected");
  assert.ok(!result.injectedEnv.some((k) => k.startsWith("SMTP_")), "injectedEnv must not contain SMTP vars");
});

test("deploy does NOT create a mailbox row", async () => {
  const store = new InMemoryStore();
  await provisionProjectServices(store, provisioner, project);

  const mb = await store.getMailboxByProject(project.id);
  assert.equal(mb, null, "no mailbox row should be created during deploy");
});

test("deploy still provisions the database and injects DATABASE_URL", async () => {
  const store = new InMemoryStore();
  const result = await provisionProjectServices(store, provisioner, project);

  assert.ok(result.databaseCreated, "database should be created");
  assert.ok(result.injectedEnv.includes("DATABASE_URL"), "DATABASE_URL must be injected");
});

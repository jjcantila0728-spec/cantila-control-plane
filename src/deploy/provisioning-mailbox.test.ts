import { test } from "node:test";
import assert from "node:assert/strict";

import { provisionProjectServices } from "./provisioning";
import type { ServiceProvisioner } from "./provisioning";
import { InMemoryStore } from "../domain/store";
import { isEncryptedSecret } from "../lib/secrets";

const project = { id: "prj_1", slug: "acme", name: "Acme", region: "eu" } as any;

function provisionerReturning(smtpPassword: string): ServiceProvisioner {
  return {
    async createDatabase() {
      return { engine: "postgres", version: "16", connectionUri: "postgres://x@db:5432/x" };
    },
    async createMailbox() {
      return {
        address: "info@acme.cantila.app",
        sendingDomain: "acme.cantila.app",
        smtpHost: "mail.cantila.app",
        smtpUser: "info@acme.cantila.app",
        smtpPassword,
      };
    },
  };
}

test("stored mailbox password is encrypted; injected SMTP_PASSWORD is plaintext", async () => {
  process.env.CANTILA_SECRET_KEY = "test-master-key-please";
  try {
    const store = new InMemoryStore();
    await provisionProjectServices(store, provisionerReturning("real-secret-pw"), project);

    const mb = await store.getMailboxByProject(project.id);
    assert.ok(mb, "mailbox row exists");
    assert.ok(isEncryptedSecret(mb!.smtpPassword), "stored password is an enc.v1 envelope");

    const env = await store.listEnvVars(project.id);
    const pw = env.find((e) => e.key === "SMTP_PASSWORD");
    assert.equal(pw?.value, "real-secret-pw", "injected env password is plaintext");
    const host = env.find((e) => e.key === "SMTP_HOST");
    assert.equal(host?.value, "mail.cantila.app");
  } finally {
    delete process.env.CANTILA_SECRET_KEY;
  }
});

/* ============================================================
   Task 3: cp.sendMail passes the project mailbox's own SMTP auth.
   Verifies that the auth block (host/user/pass/port) is forwarded
   to mailProvider.sendMail — the key assertion from the plan.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ControlPlane } from "./control-plane";
import { InMemoryStore } from "../domain/store";
import { stubProvisioner, stubDataPlane } from "../dataplane/stub";
import { StubStripeAdapter } from "../billing/stripe";
import { RuleBasedAiAnalyser } from "../ai/analyser";

test("cp.sendMail forwards the project mailbox's own SMTP auth", async () => {
  const store = new InMemoryStore();
  const cp = new ControlPlane({
    store,
    provisioner: stubProvisioner,
    dataPlane: stubDataPlane,
    stripe: new StubStripeAdapter(),
    aiAnalyser: new RuleBasedAiAnalyser(),
  });

  // Seed an account directly in the store (required fields per Account interface).
  await store.createAccount({
    id: "acc_1",
    name: "Test Account",
    handle: "testaccount",
    plan: "starter",
    createdAt: new Date().toISOString(),
  });

  // Seed a project directly in the store (required fields per Project interface).
  await store.createProject({
    id: "prj_1",
    accountId: "acc_1",
    name: "Acme",
    slug: "acme",
    runtime: "node",
    region: "eu",
    status: "live",
    vcpu: 1,
    memoryMb: 512,
    diskGb: 10,
    alwaysOn: false,
    autoSleep: true,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    autoDeploy: false,
    createdAt: new Date().toISOString(),
  } as any);

  // Seed a mailbox with known smtpHost/smtpUser/smtpPassword.
  await store.createMailbox({
    id: "mbx_1",
    projectId: "prj_1",
    address: "info@acme.cantila.app",
    sendingDomain: "acme.cantila.app",
    smtpHost: "mail.cantila.app",
    smtpUser: "info@acme.cantila.app",
    smtpPassword: "plain-pw",
    status: "active",
    createdAt: new Date().toISOString(),
  });

  // Swap the bundled mailProvider singleton's sendMail for a spy.
  const mod = await import("../mail/provider");
  let seen: any;
  const orig = mod.mailProvider.sendMail.bind(mod.mailProvider);
  (mod.mailProvider as any).sendMail = async (input: any) => {
    seen = input;
    return { providerMessageId: "spy-msg-id", accepted: true };
  };
  try {
    const res = await cp.sendMail("prj_1", {
      to: "z@ext.com",
      subject: "S",
      body: "B",
    });
    assert.ok(!("error" in res), `unexpected error: ${JSON.stringify(res)}`);
    assert.deepEqual(seen.auth, {
      host: "mail.cantila.app",
      user: "info@acme.cantila.app",
      pass: "plain-pw",
      port: 587,
    });
    assert.equal(seen.from, "info@acme.cantila.app");
  } finally {
    (mod.mailProvider as any).sendMail = orig;
  }
});

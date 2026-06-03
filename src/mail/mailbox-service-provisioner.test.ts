import { test } from "node:test";
import assert from "node:assert/strict";

import { createMailboxServiceProvisioner } from "./mailbox-service-provisioner";
import type { MailboxProvisioner, ProvisionResult } from "./provisioner";

function fakeProvisioner(over: Partial<MailboxProvisioner> = {}): {
  prov: MailboxProvisioner;
  calls: string[];
} {
  const calls: string[] = [];
  const prov: MailboxProvisioner = {
    label: "Fake",
    live: true,
    async ensureDomain(d) { calls.push(`ensureDomain:${d}`); return { ok: true } as ProvisionResult; },
    async createMailbox(i) { calls.push(`createMailbox:${i.address}`); return { ok: true } as ProvisionResult; },
    async deleteMailbox() { return { ok: true } as ProvisionResult; },
    ...over,
  };
  return { prov, calls };
}

const project = { slug: "acme", name: "Acme" } as any;

test("provisions the project's domain + mailbox and returns real creds", async () => {
  const { prov, calls } = fakeProvisioner();
  const svc = createMailboxServiceProvisioner(prov);
  const m = await svc.createMailbox(project);

  assert.equal(m.address, "info@acme.cantila.app");
  assert.equal(m.sendingDomain, "acme.cantila.app");
  assert.equal(m.smtpHost, "mail.cantila.app");
  assert.equal(m.smtpUser, "info@acme.cantila.app");
  assert.ok(m.smtpPassword.length >= 16, "a real password is generated");
  assert.deepEqual(calls, [
    "ensureDomain:acme.cantila.app",
    "createMailbox:info@acme.cantila.app",
  ]);
});

test("ensureDomain failure aborts before creating a mailbox", async () => {
  const { prov, calls } = fakeProvisioner({
    async ensureDomain() { return { error: "boom" }; },
  });
  const svc = createMailboxServiceProvisioner(prov);
  await assert.rejects(() => svc.createMailbox(project), /ensureDomain.*boom/);
  assert.ok(!calls.some((c) => c.startsWith("createMailbox")));
});

test("createMailbox failure rejects (no ghost mailbox row)", async () => {
  const { prov } = fakeProvisioner({
    async createMailbox() { return { error: "exists-bad" }; },
  });
  const svc = createMailboxServiceProvisioner(prov);
  await assert.rejects(() => svc.createMailbox(project), /createMailbox.*exists-bad/);
});

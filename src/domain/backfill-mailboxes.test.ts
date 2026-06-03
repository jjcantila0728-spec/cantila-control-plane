import { test } from "node:test";
import assert from "node:assert/strict";

import { backfillTenantMailboxes } from "./backfill-mailboxes";
import { InMemoryStore } from "./store";
import type { MailboxProvisioner, ProvisionResult } from "../mail/provisioner";

function fakeProvisioner(): { prov: MailboxProvisioner; calls: string[] } {
  const calls: string[] = [];
  const prov: MailboxProvisioner = {
    label: "Fake", live: true,
    async ensureDomain(d) { calls.push(`dom:${d}`); return { ok: true } as ProvisionResult; },
    async createMailbox(i) { calls.push(`mbx:${i.address}`); return { ok: true } as ProvisionResult; },
    async deleteMailbox() { return { ok: true } as ProvisionResult; },
  };
  return { prov, calls };
}

async function seed(
  store: InMemoryStore,
  opts: { slug: string; smtpHost: string; platform?: boolean },
) {
  const account = await store.createAccount({
    id: `acc_${opts.slug}`,
    name: "A",
    handle: opts.slug,
    plan: "starter",
    createdAt: new Date().toISOString(),
  });
  const project = await store.createProject({
    id: `prj_${opts.slug}`,
    accountId: account.id,
    name: opts.slug,
    slug: opts.slug,
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
    platform: opts.platform ?? false,
    createdAt: new Date().toISOString(),
  } as any);
  await store.createMailbox({
    id: `mbx_${opts.slug}`,
    projectId: project.id,
    address: `info@${opts.slug}.cantila.app`,
    sendingDomain: `${opts.slug}.cantila.app`,
    smtpHost: opts.smtpHost,
    smtpUser: `info@${opts.slug}.cantila.app`,
    smtpPassword: "old-fake-pw",
    status: "active",
    createdAt: new Date().toISOString(),
  } as any);
  return project;
}

test("backfill repairs legacy tenant mailboxes once and is idempotent", async () => {
  const store = new InMemoryStore();
  await seed(store, { slug: "legacy", smtpHost: "smtp.cantila.app" });
  const { prov, calls } = fakeProvisioner();

  const r1 = await backfillTenantMailboxes(store, prov);
  assert.equal(r1.repaired, 1);
  const mb = await store.getMailboxByProject("prj_legacy");
  assert.equal(mb!.smtpHost, "mail.cantila.app");
  assert.notEqual(mb!.smtpPassword, "old-fake-pw", "password rotated to the real one");
  assert.deepEqual(calls, ["dom:legacy.cantila.app", "mbx:info@legacy.cantila.app"]);

  const r2 = await backfillTenantMailboxes(store, prov);
  assert.equal(r2.repaired, 0, "second run is a no-op");
});

test("backfill skips already-real and platform mailboxes", async () => {
  const store = new InMemoryStore();
  await seed(store, { slug: "fresh", smtpHost: "mail.cantila.app" });
  await seed(store, { slug: "platform", smtpHost: "smtp.cantila.app", platform: true });
  const { prov } = fakeProvisioner();

  const r = await backfillTenantMailboxes(store, prov);
  assert.equal(r.repaired, 0);
});

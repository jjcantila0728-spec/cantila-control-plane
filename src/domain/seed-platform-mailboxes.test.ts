import { test } from "node:test";
import assert from "node:assert/strict";

import { seedPlatformMailboxes } from "./seed-platform-mailboxes";
import { seedPlatformProject, PLATFORM_PROJECT_ID } from "./seed-platform";
import { InMemoryStore } from "./store";
import type {
  MailboxProvisioner,
  ProvisionResult,
  ProvisionedMailbox,
} from "../mail/provisioner";

function fakeProvisioner(live: ProvisionedMailbox[]): MailboxProvisioner {
  return {
    label: "Fake",
    live: true,
    async ensureDomain() {
      return { ok: true } as ProvisionResult;
    },
    async createMailbox() {
      return { ok: true } as ProvisionResult;
    },
    async deleteMailbox() {
      return { ok: true } as ProvisionResult;
    },
    async listMailboxes(domain) {
      return live.filter((m) => m.address.endsWith(`@${domain}`));
    },
  };
}

test("adopts live cantila.app mailboxes into HostedMailbox rows, once", async () => {
  process.env.CANTILA_OWNER_ACCOUNT_ID = "acc_cantila";
  const store = new InMemoryStore();
  await seedPlatformProject(store);
  const prov = fakeProvisioner([
    { address: "info@cantila.app", displayName: "Cantila", quotaMb: 10240, usedMb: 1 },
    { address: "noreply@cantila.app", displayName: "No Reply", quotaMb: 5120, usedMb: 0 },
    // A tenant-domain mailbox must NOT be adopted onto the platform project.
    { address: "info@grittrade.cantila.app", quotaMb: 10240, usedMb: 0 },
  ]);

  const r1 = await seedPlatformMailboxes(store, prov);
  assert.equal(r1.adopted, 2, "both platform-domain mailboxes adopted");
  assert.equal(r1.scanned, 2, "only @cantila.app mailboxes scanned");

  const rows = await store.listHostedMailboxesByProject(PLATFORM_PROJECT_ID);
  const addrs = rows.map((m) => m.address).sort();
  assert.deepEqual(addrs, ["info@cantila.app", "noreply@cantila.app"]);
  const info = rows.find((m) => m.address === "info@cantila.app")!;
  assert.equal(info.status, "active");
  assert.equal(info.quotaMb, 10240);

  // Idempotent: a second run adopts nothing new.
  const r2 = await seedPlatformMailboxes(store, prov);
  assert.equal(r2.adopted, 0, "second run is a no-op");
  const rows2 = await store.listHostedMailboxesByProject(PLATFORM_PROJECT_ID);
  assert.equal(rows2.length, 2, "no duplicate rows");
});

test("no-op when the platform project has not been seeded", async () => {
  const store = new InMemoryStore();
  const prov = fakeProvisioner([
    { address: "info@cantila.app", quotaMb: 10240, usedMb: 0 },
  ]);
  const r = await seedPlatformMailboxes(store, prov);
  assert.equal(r.adopted, 0);
});

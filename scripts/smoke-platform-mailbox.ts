/* ============================================================
   Platform-mailbox smoke (offline, stub provisioner).

   Run: npx tsx scripts/smoke-platform-mailbox.ts
   Exits 0 on success, 1 on the first failed assertion.

   Covers the createHostedMailbox provisioning path against the
   default StubMailboxProvisioner (no MAILCOW_* env → stub):
     1. cantila.app mailbox on the platform project → success +
        a one-time password.
     2. non-cantila.app address on the platform project → rejected
        by domain validation.
     3. duplicate address → rejected.
     4. tenant-project mailbox → success, NO one-time password
        (the provisioner is gated on project.platform).
   ============================================================ */

import { ControlPlane } from "../src/core/control-plane";
import { InMemoryStore } from "../src/domain/store";
import {
  seedPlatformProject,
  PLATFORM_PROJECT_ID,
} from "../src/domain/seed-platform";
import { now } from "../src/lib/ids";
import type { Project } from "../src/domain/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const store = new InMemoryStore();

  // Platform project (+ owner account) via the real seed.
  await seedPlatformProject(store);
  const platform = await store.getProject(PLATFORM_PROJECT_ID);
  assert(platform && platform.platform === true, "platform project seeded");
  const accountId = platform!.accountId;

  // A normal tenant project under the same account for the gating test.
  const tenant: Project = {
    id: "proj_tenant",
    accountId,
    slug: "tenant",
    name: "Tenant",
    runtime: "node",
    region: "fsn1",
    status: "live",
    vcpu: 1,
    memoryMb: 1024,
    diskGb: 5,
    alwaysOn: false,
    autoSleep: true,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    autoDeploy: false,
    platform: false,
    createdAt: now(),
  };
  await store.createProject(tenant);

  // createHostedMailbox only touches deps.store (+ the mailboxProvisioner
  // singleton), so a store-only deps object is enough for this smoke.
  const cp = new ControlPlane({ store } as never);

  // 1. platform mailbox → success + oneTimePassword
  const ok = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "info@cantila.app",
  });
  assert(!("error" in ok), `info@cantila.app should create: ${JSON.stringify(ok)}`);
  assert(
    "oneTimePassword" in ok && Boolean(ok.oneTimePassword),
    "platform mailbox returns a oneTimePassword",
  );

  // 2. wrong domain on platform project → rejected
  const bad = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "x@example.com",
  });
  assert("error" in bad, "non-cantila.app on platform project rejected");

  // 3. duplicate → rejected
  const dup = await cp.createHostedMailbox({
    projectId: PLATFORM_PROJECT_ID,
    address: "info@cantila.app",
  });
  assert("error" in dup, "duplicate address rejected");

  // 4. tenant mailbox → success, NO oneTimePassword (provisioner gated off)
  const tok = await cp.createHostedMailbox({
    projectId: "proj_tenant",
    address: "hi@tenant.com",
  });
  assert(!("error" in tok), `tenant mailbox should create: ${JSON.stringify(tok)}`);
  assert(
    !("oneTimePassword" in tok) || !tok.oneTimePassword,
    "tenant mailbox has no oneTimePassword",
  );

  console.log("PASS: platform-mailbox smoke");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});

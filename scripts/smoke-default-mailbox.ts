/* ============================================================
   Default-mailbox scheme + reconcile smoke (offline).

   Run: npx tsx scripts/smoke-default-mailbox.ts
   Exits 0 on success, 1 on the first failed assertion.

   Covers:
     1. defaultProjectMailbox(slug) → info@<slug>.cantila.app.
     2. stubProvisioner.createMailbox uses the canonical scheme.
     3. reconcileProjectMailboxes rewrites a legacy mailbox
        (mailer@<slug>.send.cantila.email) to the canonical form,
        and is idempotent on a second run.
   ============================================================ */

import { InMemoryStore } from "../src/domain/store";
import { stubProvisioner } from "../src/dataplane/stub";
import { reconcileProjectMailboxes } from "../src/domain/reconcile-mailboxes";
import { defaultProjectMailbox } from "../src/mail/default-mailbox";
import { now } from "../src/lib/ids";
import type { Account, Project } from "../src/domain/types";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function makeProject(accountId: string, slug: string): Project {
  return {
    id: `proj_${slug}`,
    accountId,
    slug,
    name: slug,
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
}

async function main(): Promise<void> {
  // 1. canonical helper
  const want = defaultProjectMailbox("cantilahomes");
  assert(
    want.address === "info@cantilahomes.cantila.app",
    `address is info@cantilahomes.cantila.app (got ${want.address})`,
  );
  assert(
    want.sendingDomain === "cantilahomes.cantila.app",
    `sendingDomain is cantilahomes.cantila.app (got ${want.sendingDomain})`,
  );

  // 2. stub provisioner uses it
  const provisioned = await stubProvisioner.createMailbox(
    makeProject("acc_x", "cantilahomes"),
  );
  assert(
    provisioned.address === "info@cantilahomes.cantila.app",
    `stub provisions info@cantilahomes.cantila.app (got ${provisioned.address})`,
  );
  assert(
    Boolean(provisioned.smtpPassword),
    "stub still mints an smtp password",
  );

  // 3. reconcile a legacy row
  const store = new InMemoryStore();
  const account: Account = {
    id: "acc_x",
    name: "X",
    handle: "x",
    plan: "dedicated",
    createdAt: now(),
  };
  await store.createAccount(account);
  const project = makeProject(account.id, "cantilahomes");
  await store.createProject(project);
  await store.createMailbox({
    id: "mbx_legacy",
    projectId: project.id,
    address: "mailer@cantilahomes.send.cantila.email",
    sendingDomain: "cantilahomes.send.cantila.email",
    smtpHost: "smtp.cantila.email",
    smtpUser: "cantilahomes",
    smtpPassword: "x".repeat(32),
    status: "active",
    createdAt: now(),
  });

  const first = await reconcileProjectMailboxes(store);
  assert(first.updated === 1, `reconcile updates the legacy row (got ${first.updated})`);
  const after = await store.getMailboxByProject(project.id);
  assert(
    after?.address === "info@cantilahomes.cantila.app",
    `legacy row rewritten to canonical (got ${after?.address})`,
  );
  assert(
    after?.sendingDomain === "cantilahomes.cantila.app",
    `sendingDomain rewritten (got ${after?.sendingDomain})`,
  );

  // idempotent
  const second = await reconcileProjectMailboxes(store);
  assert(second.updated === 0, `reconcile is idempotent (got ${second.updated})`);

  console.log("PASS: default-mailbox scheme + reconcile (6 assertions)");
}

void main();

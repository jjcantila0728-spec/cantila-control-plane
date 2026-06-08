/* ============================================================
   Boot reconcile — adopt live cantila.app mailboxes into
   HostedMailbox rows (plan §4.4).

   info@cantila.app and noreply@cantila.app were created directly in
   Mailcow during the 2026-06-01 mail go-live, never through the
   control-plane `createHostedMailbox`. The console "Mailboxes" tab
   lists only `HostedMailbox` DB rows, so those real inboxes were
   invisible to the owner. This reconcile lists the platform-domain
   mailboxes in the MTA and writes a `HostedMailbox` row for any that
   has none, hanging them off the hidden Platform project so they show
   up — and can be managed — in the console.

   The mailboxes already exist in Mailcow, so we write the DB record
   directly (no re-provisioning, no password). Idempotent — keyed on
   address, safe on every boot. Runs only when a live provisioner is
   wired (the Stub lists nothing). Mirrors seedPlatformProject.
   ============================================================ */

import type { Store } from "./store";
import type { MailboxProvisioner } from "../mail/provisioner";
import { PLATFORM_PROJECT_ID, PLATFORM_DOMAIN } from "./seed-platform";
import { id, now } from "../lib/ids";

const DEFAULT_QUOTA_MB = 10240;

export async function seedPlatformMailboxes(
  store: Store,
  provisioner: MailboxProvisioner,
): Promise<{ adopted: number; scanned: number }> {
  let adopted = 0;
  let scanned = 0;

  // No platform project → nothing to hang mailboxes off. (seed order:
  // seedPlatformProject must run first.)
  const project = await store.getProject(PLATFORM_PROJECT_ID);
  if (!project) return { adopted, scanned };

  const live = await provisioner.listMailboxes(PLATFORM_DOMAIN);
  for (const mb of live) {
    const address = mb.address.trim().toLowerCase();
    // Defensive: listMailboxes already filters by domain, but never
    // adopt a tenant-subdomain mailbox onto the platform project.
    if (!address.endsWith(`@${PLATFORM_DOMAIN}`)) continue;
    scanned++;

    const existing = await store.findHostedMailboxByAddress(address);
    if (existing) continue;

    await store.createHostedMailbox({
      id: id("mbx"),
      projectId: PLATFORM_PROJECT_ID,
      address,
      displayName: mb.displayName?.trim() || address.split("@")[0],
      // Platform addresses (info@, noreply@) are role inboxes.
      kind: "shared",
      quotaMb: mb.quotaMb > 0 ? mb.quotaMb : DEFAULT_QUOTA_MB,
      usedMb: mb.usedMb,
      status: "active",
      createdAt: now(),
    });
    adopted++;
  }

  return { adopted, scanned };
}

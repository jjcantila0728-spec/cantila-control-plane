/* ============================================================
   Boot reconcile — migrate auto-wired project mailboxes to the
   canonical `info@<slug>.cantila.app` scheme.

   Projects deployed before the scheme change carry legacy addresses
   (e.g. `mailer@<slug>.send.cantila.email`). This rewrites every
   project's auto-wired mailbox to the canonical form so the Console
   fleet and the `MAIL_FROM` identity line up. Idempotent — rows that
   already match are skipped, so it is safe on every boot.

   Note: this updates the stored Mailbox row only. A project's already
   injected SMTP_* / MAIL_FROM env re-syncs on its next deploy.
   ============================================================ */

import type { Store } from "./store";
import { defaultProjectMailbox, isCanonicalMailbox } from "../mail/default-mailbox";

export async function reconcileProjectMailboxes(
  store: Store,
): Promise<{ updated: number; scanned: number }> {
  let updated = 0;
  let scanned = 0;
  const accounts = await store.listAccounts();
  for (const account of accounts) {
    const projects = await store.listProjects(account.id);
    for (const project of projects) {
      const mb = await store.getMailboxByProject(project.id);
      if (!mb) continue;
      scanned++;
      if (isCanonicalMailbox(mb, project.slug)) continue;
      const want = defaultProjectMailbox(project.slug);
      await store.updateMailbox(mb.id, {
        address: want.address,
        sendingDomain: want.sendingDomain,
        smtpHost: want.smtpHost,
        smtpUser: want.smtpUser,
      });
      updated++;
    }
  }
  return { updated, scanned };
}

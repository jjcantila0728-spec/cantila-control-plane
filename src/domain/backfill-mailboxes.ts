/* ============================================================
   Boot backfill — give legacy tenant projects a REAL Mailcow
   mailbox (tenant-outbound-mail spec §5).

   Projects auto-wired while mailbox creation was record-only carry a
   fabricated password and the old `smtp.cantila.app` host. For each
   such tenant mailbox this provisions the real domain + mailbox in
   Mailcow, rotates the stored password (encrypted at rest), fixes the
   host, and re-injects the project's SMTP_* env so its next deploy
   picks up working credentials.

   Detection signal: `smtpHost !== "mail.cantila.app"`. Idempotent —
   once repaired the host matches and the row is skipped. Must run
   BEFORE `reconcileProjectMailboxes` (which rewrites smtpHost).
   Platform (`project.platform`) mailboxes are already real and skipped
   (listProjects already filters out platform projects, and the explicit
   guard below makes the intent clear).
   ============================================================ */

import type { Store } from "./store";
import type { MailboxProvisioner } from "../mail/provisioner";
import { defaultProjectMailbox } from "../mail/default-mailbox";
import { encryptSecret } from "../lib/secrets";
import { id, now } from "../lib/ids";
import { randomBytes } from "node:crypto";

const REAL_HOST = "mail.cantila.app";
const DEFAULT_QUOTA_MB = 10240;

export async function backfillTenantMailboxes(
  store: Store,
  provisioner: MailboxProvisioner,
): Promise<{ repaired: number; scanned: number }> {
  let repaired = 0;
  let scanned = 0;
  const accounts = await store.listAccounts();
  for (const account of accounts) {
    const projects = await store.listProjects(account.id);
    for (const project of projects) {
      // listProjects already excludes platform projects in InMemoryStore;
      // this guard makes the intent explicit for any store implementation
      // that does not filter at the query level.
      if (project.platform) continue;
      const mb = await store.getMailboxByProject(project.id);
      if (!mb) continue;
      scanned++;
      if (mb.smtpHost === REAL_HOST) continue; // already real

      const base = defaultProjectMailbox(project.slug);
      const password = randomBytes(18).toString("base64url");
      const dom = await provisioner.ensureDomain(base.sendingDomain);
      if ("error" in dom) {
        console.error(`[backfill] ${project.slug}: ensureDomain failed: ${dom.error}`);
        continue;
      }
      const made = await provisioner.createMailbox({
        address: base.address,
        password,
        quotaMb: DEFAULT_QUOTA_MB,
        displayName: project.name || project.slug,
      });
      if ("error" in made) {
        console.error(`[backfill] ${project.slug}: createMailbox failed: ${made.error}`);
        continue;
      }

      await store.updateMailbox(mb.id, {
        address: base.address,
        sendingDomain: base.sendingDomain,
        smtpHost: base.smtpHost,
        smtpUser: base.smtpUser,
        smtpPassword: encryptSecret(password),
      });
      // Re-inject working SMTP_* env (plaintext password) for next deploy.
      const envs: Array<[string, string]> = [
        ["SMTP_HOST", base.smtpHost],
        ["SMTP_PORT", "587"],
        ["SMTP_USER", base.smtpUser],
        ["SMTP_PASSWORD", password],
        ["MAIL_FROM", base.address],
      ];
      for (const [key, value] of envs) {
        await store.upsertEnvVar({
          id: id("env"),
          projectId: project.id,
          key,
          value,
          secret: true,
          scope: "all",
          updatedAt: now(),
        });
      }
      repaired++;
    }
  }
  return { repaired, scanned };
}

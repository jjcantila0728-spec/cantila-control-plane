/* ============================================================
   Live mailbox creation for the data-plane `ServiceProvisioner`
   seam (plan §4.2 / tenant-outbound-mail spec).

   The stub's `createMailbox` is record-only — it fabricates a
   random password and never creates a real mailbox. This wraps the
   Mailcow REST `MailboxProvisioner` so a tenant project gets a real,
   login-capable `info@<slug>.cantila.app` mailbox at deploy time,
   returning the generated password as `smtpPassword`.

   Env-gated via `createLiveMailboxServiceProvisioner`: returns null
   unless the bundled `mailboxProvisioner` is live (MAILCOW_URL +
   MAILCOW_API_KEY set), so dev/test stay on the stub.
   ============================================================ */

import { randomBytes } from "node:crypto";

import type { Project } from "../domain/types";
import type { ServiceProvisioner } from "../deploy/provisioning";
import { defaultProjectMailbox } from "./default-mailbox";
import { mailboxProvisioner, type MailboxProvisioner } from "./provisioner";

/** Default mailbox quota for an auto-wired tenant mailbox (10 GB). */
const DEFAULT_QUOTA_MB = 10240;

/** Build a `ServiceProvisioner`-shaped object whose `createMailbox`
 *  actually provisions a Mailcow mailbox via `provisioner`. */
export function createMailboxServiceProvisioner(
  provisioner: MailboxProvisioner,
): Pick<ServiceProvisioner, "createMailbox"> {
  return {
    async createMailbox(project: Project) {
      const base = defaultProjectMailbox(project.slug);
      const password = randomBytes(18).toString("base64url");

      const dom = await provisioner.ensureDomain(base.sendingDomain);
      if ("error" in dom) {
        throw new Error(`ensureDomain(${base.sendingDomain}): ${dom.error}`);
      }
      const made = await provisioner.createMailbox({
        address: base.address,
        password,
        quotaMb: DEFAULT_QUOTA_MB,
        displayName: project.name || base.address.split("@")[0],
      });
      if ("error" in made) {
        throw new Error(`createMailbox(${base.address}): ${made.error}`);
      }
      return {
        address: base.address,
        sendingDomain: base.sendingDomain,
        smtpHost: base.smtpHost,
        smtpUser: base.smtpUser,
        smtpPassword: password,
      };
    },
  };
}

/** Env-gated factory — returns the live mailbox createMailbox only when
 *  the bundled Mailcow provisioner is live, else null (caller keeps the
 *  stub). */
export function createLiveMailboxServiceProvisioner():
  | Pick<ServiceProvisioner, "createMailbox">
  | null {
  if (!mailboxProvisioner.live) return null;
  return createMailboxServiceProvisioner(mailboxProvisioner);
}

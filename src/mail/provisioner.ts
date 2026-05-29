/* ============================================================
   Mailbox provisioning port (plan §4.4).

   DELIBERATELY SEPARATE from the sending `MailProvider`:
   provisioning talks to Mailcow's REST admin API; sending is SMTP
   submission. Keeping them apart means wiring real provisioning
   does NOT flip the sending path "live" (which would suppress the
   password-reset / verify `debugLink` before SMTP actually works).

   Stub today; `MailcowMailboxProvisioner` auto-selects when
   MAILCOW_URL + MAILCOW_API_KEY are present — same env-gated
   factory pattern as `createMailProvider()`.
   ============================================================ */

import { MailcowMailboxProvisioner } from "./mailcow-provisioner";

export type ProvisionResult = { ok: true } | { error: string };

export interface MailboxProvisioner {
  /** Display label — surfaced so an operator knows whether the
   *  control plane is talking to the stub or a real Mailcow. */
  readonly label: string;
  /** False for the stub; true for a real Mailcow adapter. */
  readonly live: boolean;
  /** Ensure the sending domain exists in the MTA (idempotent). */
  ensureDomain(domain: string): Promise<ProvisionResult>;
  /** Create a real, login-capable mailbox. */
  createMailbox(input: {
    address: string;
    password: string;
    quotaMb: number;
    displayName?: string;
  }): Promise<ProvisionResult>;
  /** Remove a mailbox (used when a hosted mailbox is deleted). */
  deleteMailbox(address: string): Promise<ProvisionResult>;
}

/** Deterministic no-op. Keeps offline smoke + tests deterministic —
 *  the control plane behaves identically with no MTA wired. */
export class StubMailboxProvisioner implements MailboxProvisioner {
  readonly label = "Stub provisioner";
  readonly live = false;
  async ensureDomain(): Promise<ProvisionResult> {
    return { ok: true };
  }
  async createMailbox(): Promise<ProvisionResult> {
    return { ok: true };
  }
  async deleteMailbox(): Promise<ProvisionResult> {
    return { ok: true };
  }
}

/** Auto-selects the live adapter on env-var presence. Importing the
 *  Mailcow adapter does no I/O until it is instantiated, so a static
 *  import is safe and avoids any ESM/CJS `require` mismatch. */
export function createMailboxProvisioner(): MailboxProvisioner {
  if (process.env.MAILCOW_URL && process.env.MAILCOW_API_KEY) {
    return new MailcowMailboxProvisioner({
      url: process.env.MAILCOW_URL,
      apiKey: process.env.MAILCOW_API_KEY,
    });
  }
  return new StubMailboxProvisioner();
}

export const mailboxProvisioner: MailboxProvisioner = createMailboxProvisioner();

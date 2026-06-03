/* ============================================================
   Auto-wired services — the headline behaviour (plan §4.2).
   Every project gets its OWN database and email, connected before
   the first build runs. SMS is NOT auto-wired — it is opt-in per
   project: a tenant activates SMS explicitly (see
   `ControlPlane.activateSms`), which provisions a real Telnyx number
   and injects `CANTILA_SMS_*` on demand.
   ============================================================ */

import type { Store } from "../domain/store";
import type { Project, DbEngine } from "../domain/types";
import { id, now } from "../lib/ids";
import { encryptSecret } from "../lib/secrets";

/**
 * Data-plane contract — actually stands up the underlying services.
 * The scaffold provides a simulated implementation in
 * src/dataplane/stub.ts; production wires real managed-service backends.
 */
export interface ServiceProvisioner {
  createDatabase(project: Project): Promise<{
    engine: DbEngine;
    version: string;
    connectionUri: string;
  }>;
  createMailbox(project: Project): Promise<{
    address: string;
    sendingDomain: string;
    smtpHost: string;
    smtpUser: string;
    smtpPassword: string;
  }>;
  /** Tear down a previously-provisioned database. Optional — the stub
   *  omits it (no real backend); the Coolify provisioner deletes the
   *  underlying managed Postgres identified by its connection URI.
   *  Best-effort by contract. */
  destroyDatabase?(connectionUri: string): Promise<void>;
}

export interface ProvisionResult {
  databaseCreated: boolean;
  mailboxCreated: boolean;
  /** Names of the env vars injected into the project this run. */
  injectedEnv: string[];
}

/**
 * Auto-wires a project's bundled services. Idempotent — safe to run on
 * every deploy. On the first deploy it creates the project's own database
 * and mailbox, then injects their credentials into the project environment
 * as secrets so the app is connected before it builds. On later deploys
 * every service already exists and this is a fast no-op. SMS is opt-in and
 * is provisioned separately by `ControlPlane.activateSms`.
 */
export async function provisionProjectServices(
  store: Store,
  provisioner: ServiceProvisioner,
  project: Project,
): Promise<ProvisionResult> {
  const injectedEnv: string[] = [];
  let databaseCreated = false;
  let mailboxCreated = false;

  async function inject(key: string, value: string): Promise<void> {
    await store.upsertEnvVar({
      id: id("env"),
      projectId: project.id,
      key,
      value,
      secret: true,
      scope: "all",
      updatedAt: now(),
    });
    injectedEnv.push(key);
  }

  // --- dedicated database ---
  const existingDb = await store.getDatabaseByProject(project.id);
  if (!existingDb) {
    const d = await provisioner.createDatabase(project);
    const database = await store.createDatabase({
      id: id("db"),
      projectId: project.id,
      engine: d.engine,
      version: d.version,
      region: project.region,
      status: "active",
      connectionUri: d.connectionUri,
      createdAt: now(),
    });
    await inject("DATABASE_URL", database.connectionUri);
    databaseCreated = true;
  }

  // --- dedicated mailbox / email service ---
  const existingMailbox = await store.getMailboxByProject(project.id);
  if (!existingMailbox) {
    const m = await provisioner.createMailbox(project);
    const mailbox = await store.createMailbox({
      id: id("mbx"),
      projectId: project.id,
      address: m.address,
      sendingDomain: m.sendingDomain,
      smtpHost: m.smtpHost,
      smtpUser: m.smtpUser,
      // Encrypt the credential at rest; the product still gets the raw
      // value below so its own SMTP client can authenticate.
      smtpPassword: encryptSecret(m.smtpPassword),
      status: "active",
      createdAt: now(),
    });
    await inject("SMTP_HOST", mailbox.smtpHost);
    await inject("SMTP_PORT", "587");
    await inject("SMTP_USER", mailbox.smtpUser);
    await inject("SMTP_PASSWORD", m.smtpPassword);
    await inject("MAIL_FROM", mailbox.address);
    mailboxCreated = true;
  }

  // SMS is opt-in — no number is allocated here. See
  // `ControlPlane.activateSms`, which provisions a real Telnyx number and
  // injects `CANTILA_SMS_NUMBER` / `CANTILA_SMS_API_KEY` on demand.

  return { databaseCreated, mailboxCreated, injectedEnv };
}

/* ============================================================
   Auto-wired services — the headline behaviour (plan §4.2).
   Every project gets its OWN database, email and SMS, connected
   before the first build runs.
   ============================================================ */

import type { Store } from "../domain/store";
import type { Project, DbEngine } from "../domain/types";
import { id, now } from "../lib/ids";

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
  allocateNumber(project: Project): Promise<{
    e164: string;
    apiKey: string;
  }>;
}

export interface ProvisionResult {
  databaseCreated: boolean;
  mailboxCreated: boolean;
  phoneNumberCreated: boolean;
  /** Names of the env vars injected into the project this run. */
  injectedEnv: string[];
}

/**
 * Auto-wires a project's bundled services. Idempotent — safe to run on
 * every deploy. On the first deploy it creates the project's own database,
 * mailbox and SMS number, then injects their credentials into the project
 * environment as secrets so the app is connected before it builds. On later
 * deploys every service already exists and this is a fast no-op.
 */
export async function provisionProjectServices(
  store: Store,
  provisioner: ServiceProvisioner,
  project: Project,
): Promise<ProvisionResult> {
  const injectedEnv: string[] = [];
  let databaseCreated = false;
  let mailboxCreated = false;
  let phoneNumberCreated = false;

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
      smtpPassword: m.smtpPassword,
      status: "active",
      createdAt: now(),
    });
    await inject("SMTP_HOST", mailbox.smtpHost);
    await inject("SMTP_PORT", "587");
    await inject("SMTP_USER", mailbox.smtpUser);
    await inject("SMTP_PASSWORD", mailbox.smtpPassword);
    await inject("MAIL_FROM", mailbox.address);
    mailboxCreated = true;
  }

  // --- dedicated SMS number ---
  const existingNumber = await store.getPhoneNumberByProject(project.id);
  if (!existingNumber) {
    const p = await provisioner.allocateNumber(project);
    const phone = await store.createPhoneNumber({
      id: id("num"),
      projectId: project.id,
      e164: p.e164,
      region: project.region,
      status: "active",
      apiKey: p.apiKey,
      // Auto-wired numbers are full-capability (plan §4.5).
      capabilities: ["sms", "mms", "voice"],
      createdAt: now(),
    });
    await inject("CANTILA_SMS_NUMBER", phone.e164);
    await inject("CANTILA_SMS_API_KEY", phone.apiKey);
    phoneNumberCreated = true;
  }

  return { databaseCreated, mailboxCreated, phoneNumberCreated, injectedEnv };
}

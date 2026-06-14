/* ============================================================
   Auto-wired services — the headline behaviour (plan §4.2).
   Every project gets its OWN database, connected before the first
   build runs. Email, SMS, and payment are NOT auto-wired — tenants
   activate those manually from the Cantila console.

   Automation projects (automationKind: "n8n" | "openclaw") also get
   a dedicated workflow workspace with its own isolated URL, admin
   credentials, and env vars injected before the build.

   SMS is opt-in per project: a tenant activates SMS explicitly (see
   `ControlPlane.activateSms`), which provisions a real Telnyx number
   and injects `CANTILA_SMS_*` on demand.
   ============================================================ */

import type { Store } from "../domain/store";
import type { Project, DbEngine, AutomationKind } from "../domain/types";
import { id, now } from "../lib/ids";
import { encryptSecret } from "../lib/secrets";

/**
 * Data-plane contract for standing up the underlying database.
 * The scaffold provides a simulated implementation in
 * src/dataplane/stub.ts; production wires real managed-service backends.
 */
export interface ServiceProvisioner {
  createDatabase(project: Project): Promise<{
    engine: DbEngine;
    version: string;
    connectionUri: string;
  }>;
  /** Tear down a previously-provisioned database. Optional — the stub
   *  omits it (no real backend); the Coolify provisioner deletes the
   *  underlying managed Postgres identified by its connection URI.
   *  Best-effort by contract. */
  destroyDatabase?(connectionUri: string): Promise<void>;
}

/**
 * Data-plane contract for workflow workspaces (n8n / OpenClaw).
 * Each automation project gets its own isolated workspace with a
 * dedicated URL, admin user, and admin password.
 * The stub provides a simulated implementation; production provisions
 * a real containerised n8n or OpenClaw instance.
 */
export interface WorkspaceProvisioner {
  createWorkspace(
    project: Project,
    kind: AutomationKind,
  ): Promise<{
    workspaceUrl: string;
    adminUser: string;
    /** Email used as the engine's admin login (n8n requires an email
     *  identity for its owner account). */
    adminEmail: string;
    adminPassword: string;
    /** Engine API key — the SAME value injected into the container env
     *  (`OPENCLAW_API_KEY`), so the per-instance adapter can call the
     *  engine without a credential round-trip. */
    apiKey: string;
  }>;
  /** Tear down a workspace. Optional — best-effort by contract. */
  destroyWorkspace?(workspaceUrl: string): Promise<void>;
}

export interface ProvisionResult {
  databaseCreated: boolean;
  workspaceCreated: boolean;
  /** Names of the env vars injected into the project this run. */
  injectedEnv: string[];
}

/**
 * Auto-wires a project's bundled services. Idempotent — safe to run on
 * every deploy.
 *
 * On the first deploy it creates the project's own database and injects
 * `DATABASE_URL` as a secret. On later deploys the database already exists
 * and this is a fast no-op.
 *
 * For automation projects (automationKind: "n8n" | "openclaw"), a
 * dedicated workflow workspace is also provisioned on the first deploy and
 * its connection details injected as `AUTOMATION_WORKSPACE_URL`,
 * `AUTOMATION_ADMIN_USER`, `AUTOMATION_ADMIN_PASSWORD`, and
 * `AUTOMATION_KIND`.
 *
 * Email is NOT auto-wired here — tenants connect email from the Cantila
 * console. SMS is opt-in via `ControlPlane.activateSms`. Payment must be
 * configured manually.
 */
export async function provisionProjectServices(
  store: Store,
  provisioner: ServiceProvisioner,
  project: Project,
  workspaceProvisioner?: WorkspaceProvisioner,
): Promise<ProvisionResult> {
  const injectedEnv: string[] = [];
  let databaseCreated = false;
  let workspaceCreated = false;

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

  // --- workflow workspace (automation projects only) ---
  if (project.automationKind && workspaceProvisioner) {
    const alreadyProvisioned = (project.automationConfig as any)?.workspaceUrl;
    if (!alreadyProvisioned) {
      const ws = await workspaceProvisioner.createWorkspace(project, project.automationKind);
      await store.updateProject(project.id, {
        automationConfig: {
          ...(project.automationConfig ?? {}),
          workspaceUrl: ws.workspaceUrl,
          workspaceAdminUser: ws.adminUser,
          workspaceAdminEmail: ws.adminEmail,
          workspaceAdminPassword: ws.adminPassword,
          workspaceApiKey: ws.apiKey,
        },
      });
      await inject("AUTOMATION_WORKSPACE_URL", ws.workspaceUrl);
      await inject("AUTOMATION_ADMIN_USER", ws.adminUser);
      await inject("AUTOMATION_ADMIN_PASSWORD", ws.adminPassword);
      await inject("AUTOMATION_KIND", project.automationKind);
      workspaceCreated = true;
    }
  }

  // Email, SMS, and payment are NOT auto-wired here.
  // - Email: connect from the Cantila console (Mail tab → Connect mailbox).
  // - SMS:   `ControlPlane.activateSms` → provisions a Telnyx number on demand.
  // - Payment: configure Adyen/Stripe credentials manually per project.

  return { databaseCreated, workspaceCreated, injectedEnv };
}

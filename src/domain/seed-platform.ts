/* ============================================================
   Platform-project boot seed (plan §4.4).

   Ensures a single hidden "Platform" project exists under the owner
   account, owning the platform domain cantila.app. cantila.app
   hosted mailboxes (info@, etc.) hang off this project, reusing the
   project-scoped mailbox machinery. `listProjects` filters out
   platform projects so it never shows up as a tenant project.

   Idempotent — keyed on the stable project id, safe on every boot.
   Mirrors the seed-owner.ts pattern.
   ============================================================ */

import type { Store } from "./store";
import type { Project } from "./types";
import { now } from "../lib/ids";

export const PLATFORM_PROJECT_ID = "proj_platform";
export const PLATFORM_DOMAIN = "cantila.app";

export async function seedPlatformProject(
  store: Store,
): Promise<{ created: boolean; accountId: string }> {
  const accountId = process.env.CANTILA_OWNER_ACCOUNT_ID ?? "acc_cantila";

  const existing = await store.getProject(PLATFORM_PROJECT_ID);
  if (existing) return { created: false, accountId };

  // Ensure the owning account exists — the in-memory store does not
  // auto-create it the way the Prisma store's connectOrCreate does.
  const account = await store.getAccount(accountId);
  if (!account) {
    await store.createAccount({
      id: accountId,
      name: process.env.CANTILA_OWNER_ACCOUNT_NAME ?? "Cantila",
      handle: (process.env.CANTILA_OWNER_ACCOUNT_HANDLE ?? "cantila")
        .trim()
        .toLowerCase(),
      plan: "dedicated",
      createdAt: now(),
    });
  }

  const project: Project = {
    id: PLATFORM_PROJECT_ID,
    accountId,
    slug: "platform",
    name: "Platform",
    runtime: "static",
    region: "fsn1",
    status: "live",
    vcpu: 1,
    memoryMb: 512,
    diskGb: 1,
    alwaysOn: true,
    autoSleep: false,
    desiredInstances: 1,
    minInstances: 1,
    maxInstances: 1,
    autoDeploy: false,
    platform: true,
    createdAt: now(),
  };
  await store.createProject(project);
  return { created: true, accountId };
}

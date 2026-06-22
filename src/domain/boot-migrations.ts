/* ============================================================
   Boot-time additive migrations — a deliberately small bridge
   between the hand-authored `.sql` files under prisma/migrations
   and the live Postgres that today is schema-managed by
   `prisma db push` (plan §15.7, v1.12 deploy notes).

   Why this exists, briefly:
   - Cantila's prod Postgres was created via `prisma db push`, so
     the `_prisma_migrations` table is empty.
   - `prisma migrate deploy` therefore can't run on this DB until
     someone baselines the existing 24 migrations as "applied".
   - Without `migrate deploy`, the Coolify Nixpacks build that
     ships new code does nothing to the schema, so any column
     added in `schema.prisma` breaks the next redeploy.

   The clean fix is to baseline + switch to `migrate deploy` — but
   that's operational work, not a code change. Until then, this
   runner applies idempotent `IF NOT EXISTS` ALTERs at startup so
   additive nullable columns roll forward automatically.

   Discipline:
   - Only additive, nullable changes go in here.
   - Every entry MUST be idempotent (`IF NOT EXISTS`).
   - Destructive changes (DROP, NOT NULL backfill, type narrow)
     still require explicit operator action — never auto-applied.
   - Once `prisma migrate deploy` is wired, this runner retires.
     The cutover path is documented at
     `docs/PRISMA-MIGRATE-BASELINE.md` (v1.18 / F): run
     `npm run prisma:baseline` once to mark every existing
     migration as applied, then switch the boot path to
     `prisma migrate deploy` and delete this file.
   ============================================================ */

import type { PrismaClient } from "@prisma/client";

/** One additive-column migration. `id` is informational; the SQL
 *  itself is the contract — it must be idempotent so re-runs are
 *  no-ops. We don't track applied state because `IF NOT EXISTS`
 *  makes that unnecessary. */
interface AdditiveColumnMigration {
  /** Stable id (matches the migration directory under prisma/migrations
   *  for cross-referencing). Logged on apply for audit trail. */
  id: string;
  /** One human-line description. Logged on first apply. */
  description: string;
  /** The SQL to run. Must include `IF NOT EXISTS` or be otherwise
   *  idempotent against the live schema. */
  sql: string;
}

/** Append new entries when you ship a nullable-column add. Keep
 *  them in chronological order so the log reads top-down. */
const MIGRATIONS: AdditiveColumnMigration[] = [
  {
    id: "20260528000000_add_project_coolify_app_uuid",
    description:
      "Project.coolifyAppUuid — persisted Coolify Application UUID so the live data plane skips the /applications rescan on every restart (v1.17 / §19).",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "coolifyAppUuid" TEXT;',
  },
  {
    id: "20260528010000_add_user_email_verified_at",
    description:
      "User.emailVerifiedAt — ISO timestamp the user completed email_verify (v1.18 / §5.4). Nullable; absent on legacy rows reads as unverified.",
    sql: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);',
  },
  {
    id: "20260529010000_add_project_platform",
    description:
      "Project.platform — marks the seeded hidden Platform project that owns cantila.app (plan §4.4). New column WITH a default, so existing rows get false; not a NOT-NULL backfill of an existing column.",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "platform" BOOLEAN NOT NULL DEFAULT false;',
  },
  {
    id: "20260529020000_add_phone_number_marketplace_link",
    description:
      "PhoneNumber.marketplaceNumberId — links a project's SMS number to the account-owned MarketplaceNumber it was provisioned from (opt-in SMS, plan §4.5). Nullable; legacy rows stay null.",
    sql: 'ALTER TABLE "PhoneNumber" ADD COLUMN IF NOT EXISTS "marketplaceNumberId" TEXT;',
  },
  {
    id: "20260529030000_add_user_avatar_url",
    description:
      "User.avatarUrl — profile picture URL captured from social sign-in (Google picture / GitHub avatar_url, plan §5.4). Nullable; legacy rows stay null.",
    sql: 'ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;',
  },
  {
    id: "20260530010000_add_project_repo_host",
    description:
      "Project.repoHost — which git host backs the project's source: \"github\" (user-connected external repo) or \"cantila\" (auto-provisioned Gitea repo). New column WITH a default, so existing rows backfill to 'github'.",
    sql: `ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "repoHost" TEXT DEFAULT 'github';`,
  },
  {
    id: "20260530020000_create_conversation_table",
    description:
      'Conversation — multi-conversation chat history (conversations design 2026-05-30). One thread of chat per row; legacy ProjectMessage rows backfill into a "Main" conversation. FK to Project with cascade so deleting a project drops its conversations.',
    sql: `CREATE TABLE IF NOT EXISTS "Conversation" (
      "id" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "title" TEXT NOT NULL DEFAULT 'New chat',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Conversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
  },
  {
    id: "20260530020001_create_conversation_project_index",
    description:
      "Conversation [projectId, updatedAt] index — backs the conversation list ordered by most-recently-active.",
    sql: 'CREATE INDEX IF NOT EXISTS "Conversation_projectId_updatedAt_idx" ON "Conversation"("projectId", "updatedAt");',
  },
  {
    id: "20260530020002_add_project_message_conversation_id",
    description:
      "ProjectMessage.conversationId — links a chat message to its conversation (conversations design 2026-05-30). Nullable so pre-existing rows keep working until ensureDefaultConversation backfills them into 'Main'.",
    sql: 'ALTER TABLE "ProjectMessage" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;',
  },
  {
    id: "20260530020003_create_project_message_conversation_index",
    description:
      "ProjectMessage [conversationId, createdAt] index — backs the scoped per-conversation history load.",
    sql: 'CREATE INDEX IF NOT EXISTS "ProjectMessage_conversationId_createdAt_idx" ON "ProjectMessage"("conversationId", "createdAt");',
  },
  {
    id: "20260608000000_add_account_claude_subscription_token",
    description:
      "Account.claudeSubscriptionToken — per-tenant claude.ai subscription OAuth token for the build fleet (§BYO-subscription). Nullable; absent rows fall back to the platform API key.",
    sql: 'ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "claudeSubscriptionToken" TEXT;',
  },
  {
    id: "20260610000000_add_project_build_pack",
    description:
      'Project.buildPack — Coolify build pack for the repo ("nixpacks" | "dockerfile" | "dockercompose" | "static"), written by bootstrapGit/connectGit stack detection. Null = legacy nixpacks default.',
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "buildPack" TEXT;',
  },
  {
    id: "20260610000001_add_project_app_port",
    description:
      "Project.appPort — container port the app listens on (Coolify ports_exposes). Null = legacy default (3000, or 80 for static).",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "appPort" INTEGER;',
  },
  {
    id: "20260611000000_add_project_mobile_stack",
    description:
      'Project.mobileStack — mobile app stack ("expo" | "react-native" | "flutter" | "capacitor" | "android-native") written by detectMobileStack. Null = web-only project.',
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "mobileStack" TEXT;',
  },
  {
    id: "20260611000001_add_project_android_application_id",
    description:
      "Project.androidApplicationId — Android package name for Play releases (app.cantila.<slug> default, stable once set).",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "androidApplicationId" TEXT;',
  },
  {
    id: "20260611000002_add_project_android_keystore",
    description:
      "Project.androidKeystore — Cantila-managed Android signing keystore, base64, encrypted at rest (enc.v1 envelope).",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "androidKeystore" TEXT;',
  },
  {
    id: "20260611000003_add_project_android_keystore_secret",
    description:
      "Project.androidKeystoreSecret — keystore passwords JSON, encrypted at rest (enc.v1 envelope).",
    sql: 'ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "androidKeystoreSecret" TEXT;',
  },
  {
    id: "20260611000004_create_mobile_build",
    description:
      "MobileBuild table — mobile app builds (source → signed .aab/.apk) for the mobile pipeline (spec 2026-06-11).",
    sql: `CREATE TABLE IF NOT EXISTS "MobileBuild" (
      "id" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "platform" TEXT NOT NULL,
      "mobileStack" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'queued',
      "artifactKind" TEXT NOT NULL DEFAULT 'aab',
      "artifactPath" TEXT,
      "artifactSize" INTEGER,
      "applicationId" TEXT NOT NULL,
      "versionCode" INTEGER NOT NULL,
      "versionName" TEXT NOT NULL,
      "log" TEXT,
      "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "finishedAt" TIMESTAMP(3),
      CONSTRAINT "MobileBuild_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "MobileBuild_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
  },
  {
    id: "20260611000005_create_mobile_build_project_index",
    description:
      "MobileBuild [projectId, createdAt] index — backs the per-project build list (newest first).",
    sql: 'CREATE INDEX IF NOT EXISTS "MobileBuild_projectId_createdAt_idx" ON "MobileBuild"("projectId", "createdAt");',
  },
  {
    id: "20260611000006_create_store_release",
    description:
      "StoreRelease table — app-store submissions of finished mobile builds (Google Play now, App Store coming soon).",
    sql: `CREATE TABLE IF NOT EXISTS "StoreRelease" (
      "id" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "buildId" TEXT NOT NULL,
      "store" TEXT NOT NULL,
      "track" TEXT NOT NULL DEFAULT 'internal',
      "status" TEXT NOT NULL,
      "externalRef" TEXT,
      "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "StoreRelease_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "StoreRelease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "StoreRelease_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "MobileBuild"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
  },
  {
    id: "20260611000007_create_store_release_project_index",
    description:
      "StoreRelease [projectId, createdAt] index — backs the per-project release list (newest first).",
    sql: 'CREATE INDEX IF NOT EXISTS "StoreRelease_projectId_createdAt_idx" ON "StoreRelease"("projectId", "createdAt");',
  },
  {
    id: "20260622000000_create_connection_secret",
    description:
      "ConnectionSecret table — durable, encrypted-at-rest store for Cantila Connections credential payloads (API-key fields + OAuth access/refresh tokens, plan §4.11/§15.5). Replaces the process-memory Map so saved connections survive a control-plane redeploy and work across instances. `payload` holds the enc.v1 envelope (or plaintext JSON when CANTILA_SECRET_KEY is unset).",
    sql: `CREATE TABLE IF NOT EXISTS "ConnectionSecret" (
      "ref" TEXT NOT NULL,
      "payload" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ConnectionSecret_pkey" PRIMARY KEY ("ref")
    );`,
  },
];

/** Apply every additive migration. Safe to call multiple times.
 *  Errors don't crash the process — they log and continue, so a
 *  permissions issue on one ALTER doesn't take down the whole
 *  control plane. The caller decides whether to fail-fast on the
 *  reported count of failures. */
export async function applyBootMigrations(
  prisma: PrismaClient,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const m of MIGRATIONS) {
    try {
      // $executeRawUnsafe is appropriate here — the SQL is static
      // (string-literal `sql` field, no caller-supplied bindings).
      await prisma.$executeRawUnsafe(m.sql);
      console.log(`[boot-migrate] ${m.id} ok — ${m.description}`);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[boot-migrate] ${m.id} FAILED — ${message}`);
      failed++;
    }
  }
  return { applied, failed };
}

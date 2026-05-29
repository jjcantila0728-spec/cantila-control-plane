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

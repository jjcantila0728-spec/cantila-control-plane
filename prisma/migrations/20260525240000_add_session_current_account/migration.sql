-- ============================================================
-- DRAFT MIGRATION — add_session_current_account (plan §18 — Option B
-- tenancy: per-session active org)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a single
-- nullable column to the `Session` table so the control plane can
-- remember which Account a logged-in user is currently scoped to. Null
-- = no active org (e.g. a user with no memberships yet).
--
-- Backward-compatible: nullable, no default, no existing column touched.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new `Session` column. See the earlier draft
-- migrations for the same caveats.
-- ============================================================

-- AlterTable
ALTER TABLE "Session"
    ADD COLUMN "currentAccountId" TEXT;

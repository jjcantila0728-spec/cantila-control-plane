-- ============================================================
-- DRAFT MIGRATION — add_account_branding (plan §5.5 — white-label
-- per-sub-account branding).
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds four
-- nullable branding columns to `Account` so a sub-account (or any
-- account, really) can carry its own visual identity: primary +
-- accent colour, logo URL, and a display-name override. Legacy rows
-- backfill to NULL — the Console renders default Cantila chrome when
-- everything is null. Purely additive.
--
-- Validation (hex colour shape, URL shape, length limits) lives at
-- the ControlPlane layer to keep this migration boring.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane.
-- ============================================================

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "brandPrimaryColor" TEXT;
ALTER TABLE "Account" ADD COLUMN "brandAccentColor" TEXT;
ALTER TABLE "Account" ADD COLUMN "brandLogoUrl" TEXT;
ALTER TABLE "Account" ADD COLUMN "brandDisplayName" TEXT;

-- ============================================================
-- DRAFT MIGRATION — add_phone_capabilities (plan §4.5 — per-number
-- capability metadata)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a
-- `capabilities` column to the auto-wired per-project `PhoneNumber`
-- table — a comma-separated list (e.g. "sms,mms,voice"), the same shape
-- `MarketplaceNumber.capabilities` already uses.
--
-- Backward-compatible: the column has a DEFAULT, so every existing
-- `PhoneNumber` row backfills to the full "sms,mms,voice" set. No
-- existing column, enum or index is altered.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new `PhoneNumber` column. See the earlier draft
-- migrations for the same caveats.
-- ============================================================

-- AlterTable
ALTER TABLE "PhoneNumber"
    ADD COLUMN "capabilities" TEXT NOT NULL DEFAULT 'sms,mms,voice';

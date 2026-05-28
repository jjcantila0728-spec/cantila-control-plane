-- ============================================================
-- DRAFT MIGRATION — add_call_routing (plan §4.5 — inbound voice routing)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `CallRoutingAction` enum and two columns to the existing `PhoneNumber`
-- table so each project's number carries an inbound-call routing rule
-- (forward / voicemail / reject / app_webhook).
--
-- Backward-compatible: `callRoutingAction` has a DEFAULT, so every
-- existing `PhoneNumber` row backfills to `voicemail`; `callRoutingTarget`
-- is nullable. No existing column or enum is altered.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new `PhoneNumber` columns. See the earlier draft
-- migrations for the same caveats.
-- ============================================================

-- CreateEnum
CREATE TYPE "CallRoutingAction" AS ENUM ('forward', 'voicemail', 'reject', 'app_webhook');

-- AlterTable
ALTER TABLE "PhoneNumber"
    ADD COLUMN "callRoutingAction" "CallRoutingAction" NOT NULL DEFAULT 'voicemail',
    ADD COLUMN "callRoutingTarget" TEXT;

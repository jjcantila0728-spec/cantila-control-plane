-- ============================================================
-- DRAFT MIGRATION — add_number_stripe_item (plan §8 — number fees
-- as real Stripe subscription items)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a single
-- nullable column to the existing `MarketplaceNumber` table so each
-- account-owned number can carry the Stripe `SubscriptionItem` id that
-- bills its recurring monthly lease.
--
-- Backward-compatible: `stripeSubscriptionItemId` is nullable with no
-- default, so every existing `MarketplaceNumber` row backfills to NULL
-- (billing for legacy numbers reconciles on the next lifecycle event).
-- No existing column, enum or index is altered.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new `MarketplaceNumber` column. See the earlier
-- draft migrations for the same caveats.
-- ============================================================

-- AlterTable
ALTER TABLE "MarketplaceNumber"
    ADD COLUMN "stripeSubscriptionItemId" TEXT;

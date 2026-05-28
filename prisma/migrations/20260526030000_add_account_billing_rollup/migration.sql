-- ============================================================
-- DRAFT MIGRATION — add_account_billing_rollup (plan §5.5 —
-- white-label billing-rollup).
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a
-- nullable `billedToAccountId` pointer to `Account`. When set, the
-- account does NOT carry its own Stripe subscription — every Stripe
-- charge that would land on its own subscription (number leases,
-- plan-tier fees, etc.) is routed to the referenced account's
-- subscription instead. Two-level only, enforced at the ControlPlane
-- layer (no transitive rollup — a sub-account on rollup cannot
-- itself be the target of someone else's rollup).
--
-- Legacy rows backfill to NULL = "pays its own bill". Purely
-- additive.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane.
-- ============================================================

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "billedToAccountId" TEXT;

-- CreateIndex
CREATE INDEX "Account_billedToAccountId_idx" ON "Account"("billedToAccountId");

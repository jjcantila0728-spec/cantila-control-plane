-- ============================================================
-- DRAFT MIGRATION — add_dunning (plan §8 / §15.2 — billing dunning)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `BillingStatus` enum and four dunning columns to the existing
-- `Account` table so the dunning state machine (src/billing/dunning.ts)
-- has somewhere to persist billing health.
--
-- It is backward-compatible: every new column has a DEFAULT, so the
-- ALTER backfills every existing row to a healthy state — `active`,
-- 0 attempts, no clocks. No account is ever silently put in dunning by
-- applying this migration.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `Account.billingStatus` and the dunning columns.
-- See prisma/migrations/20260525130000_add_session for the same caveats.
-- ============================================================

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('active', 'past_due', 'suspended', 'canceled');

-- AlterTable
ALTER TABLE "Account"
    ADD COLUMN "billingStatus" "BillingStatus" NOT NULL DEFAULT 'active',
    ADD COLUMN "dunningAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "dunningFailedAt" TIMESTAMP(3),
    ADD COLUMN "dunningGraceEndsAt" TIMESTAMP(3);

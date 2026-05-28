-- ============================================================
-- DRAFT MIGRATION — add_marketplace_number (plan §4.5 — number marketplace)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `MarketplaceNumber` table (and its two enums) that backs the Cantila
-- SMS phone-number marketplace — numbers an account purchases, distinct
-- from the auto-wired per-project `PhoneNumber`.
--
-- Purely additive: no existing table, column or enum is altered, so it
-- is safe to apply to a database that already holds the rest of the
-- schema. The `Account` model it references already exists.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `MarketplaceNumber`. See the earlier draft migrations
-- (20260525130000_add_session, 20260525140000_add_dunning) for the same
-- caveats.
-- ============================================================

-- CreateEnum
CREATE TYPE "PhoneNumberType" AS ENUM ('local', 'toll_free', 'mobile', 'short_code');

-- CreateEnum
CREATE TYPE "MarketplaceNumberStatus" AS ENUM ('active', 'porting', 'released');

-- CreateTable
CREATE TABLE "MarketplaceNumber" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "numberType" "PhoneNumberType" NOT NULL,
    "capabilities" TEXT NOT NULL,
    "setupPriceCents" INTEGER NOT NULL,
    "monthlyPriceCents" INTEGER NOT NULL,
    "status" "MarketplaceNumberStatus" NOT NULL DEFAULT 'active',
    "providerId" TEXT NOT NULL,
    "projectId" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "MarketplaceNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceNumber_e164_key" ON "MarketplaceNumber"("e164");

-- CreateIndex
CREATE INDEX "MarketplaceNumber_accountId_idx" ON "MarketplaceNumber"("accountId");

-- AddForeignKey
ALTER TABLE "MarketplaceNumber" ADD CONSTRAINT "MarketplaceNumber_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

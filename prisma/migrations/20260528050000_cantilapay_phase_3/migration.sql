-- ============================================================
-- Cantilapay — Phase 3 (Connect-equivalent: payouts + balance) (plan §25).
--
-- Adds BalanceTransaction (the merchant ledger) and Payout (the
-- settlement record). Existing models (PaymentIntent, Refund)
-- begin writing BalanceTransaction rows in Phase 3 code; the
-- column adds here are SQL-side scaffolding only.
--
-- Plan: §25 Phase 3, cantilapay v1.
-- ============================================================

-- ----- enums -----

CREATE TYPE "CantilapayPayoutStatus" AS ENUM (
    'pending',
    'in_transit',
    'paid',
    'failed',
    'canceled'
);

CREATE TYPE "CantilapayBalanceTransactionType" AS ENUM (
    'charge',
    'refund',
    'payout',
    'platform_fee',
    'adjustment'
);

-- ----- tables -----

CREATE TABLE "CantilapayBalanceTransaction" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "type" "CantilapayBalanceTransactionType" NOT NULL,
    "description" TEXT,
    "sourcePaymentIntentId" TEXT,
    "sourceRefundId" TEXT,
    "sourcePayoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayBalanceTransaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayBalanceTransaction_cantilapayAccountId_mode_createdAt_idx" ON "CantilapayBalanceTransaction"("cantilapayAccountId", "mode", "createdAt");
CREATE INDEX "CantilapayBalanceTransaction_sourcePaymentIntentId_idx" ON "CantilapayBalanceTransaction"("sourcePaymentIntentId");
CREATE INDEX "CantilapayBalanceTransaction_sourceRefundId_idx" ON "CantilapayBalanceTransaction"("sourceRefundId");
CREATE INDEX "CantilapayBalanceTransaction_sourcePayoutId_idx" ON "CantilapayBalanceTransaction"("sourcePayoutId");

CREATE TABLE "CantilapayPayout" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "CantilapayPayoutStatus" NOT NULL DEFAULT 'pending',
    "arrivalDate" TIMESTAMP(3) NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "pspPayoutRef" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    CONSTRAINT "CantilapayPayout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayPayout_cantilapayAccountId_mode_status_idx" ON "CantilapayPayout"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayPayout_arrivalDate_idx" ON "CantilapayPayout"("arrivalDate");

-- ----- foreign keys -----

ALTER TABLE "CantilapayBalanceTransaction" ADD CONSTRAINT "CantilapayBalanceTransaction_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPayout" ADD CONSTRAINT "CantilapayPayout_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

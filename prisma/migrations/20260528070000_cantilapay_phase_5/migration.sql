-- ============================================================
-- Cantilapay — Phase 5 (Tax calculation) (plan §25).
-- ============================================================

CREATE TABLE "CantilapayTaxCalculation" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "customerCountry" TEXT NOT NULL,
    "customerState" TEXT,
    "customerPostalCode" TEXT,
    "taxAmount" INTEGER NOT NULL,
    "taxRateBps" INTEGER NOT NULL,
    "breakdown" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stub',
    "productCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayTaxCalculation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayTaxCalculation_cantilapayAccountId_mode_createdAt_idx" ON "CantilapayTaxCalculation"("cantilapayAccountId", "mode", "createdAt");

ALTER TABLE "CantilapayTaxCalculation" ADD CONSTRAINT "CantilapayTaxCalculation_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

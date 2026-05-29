-- ============================================================
-- Cantilapay — Phase 4 (Hosted Checkout + Billing Portal) (plan §25).
--
-- Plan: §25 Phase 4, cantilapay v1.
-- ============================================================

-- ----- enums -----

CREATE TYPE "CantilapayCheckoutSessionMode" AS ENUM ('payment', 'subscription', 'setup');
CREATE TYPE "CantilapayCheckoutSessionStatus" AS ENUM ('open', 'complete', 'expired');
CREATE TYPE "CantilapayCheckoutUiMode" AS ENUM ('hosted', 'embedded');
CREATE TYPE "CantilapayBillingPortalSessionStatus" AS ENUM ('open', 'used', 'expired');

-- ----- tables -----

CREATE TABLE "CantilapayCheckoutSession" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "sessionMode" "CantilapayCheckoutSessionMode" NOT NULL,
    "status" "CantilapayCheckoutSessionStatus" NOT NULL DEFAULT 'open',
    "uiMode" "CantilapayCheckoutUiMode" NOT NULL DEFAULT 'hosted',
    "customerId" TEXT,
    "lineItems" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amountTotal" INTEGER NOT NULL DEFAULT 0,
    "successUrl" TEXT NOT NULL,
    "cancelUrl" TEXT,
    "returnUrl" TEXT,
    "paymentIntentId" TEXT,
    "subscriptionId" TEXT,
    "url" TEXT,
    "clientSecret" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayCheckoutSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayCheckoutSession_cantilapayAccountId_mode_status_idx" ON "CantilapayCheckoutSession"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayCheckoutSession_expiresAt_idx" ON "CantilapayCheckoutSession"("expiresAt");

CREATE TABLE "CantilapayBillingPortalSession" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "customerId" TEXT NOT NULL,
    "returnUrl" TEXT,
    "status" "CantilapayBillingPortalSessionStatus" NOT NULL DEFAULT 'open',
    "url" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    CONSTRAINT "CantilapayBillingPortalSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayBillingPortalSession_cantilapayAccountId_mode_status_idx" ON "CantilapayBillingPortalSession"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayBillingPortalSession_expiresAt_idx" ON "CantilapayBillingPortalSession"("expiresAt");

-- ----- foreign keys -----

ALTER TABLE "CantilapayCheckoutSession" ADD CONSTRAINT "CantilapayCheckoutSession_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayBillingPortalSession" ADD CONSTRAINT "CantilapayBillingPortalSession_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

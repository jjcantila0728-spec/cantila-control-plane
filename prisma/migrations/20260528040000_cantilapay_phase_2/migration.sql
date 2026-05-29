-- ============================================================
-- Cantilapay — Phase 2 (Subscriptions) (plan §25).
--
-- Adds Product, Price, Subscription, Invoice, InvoiceItem and
-- 3 enums for recurring billing. The in-process billing-engine
-- drives period advance + dunning; no external scheduler.
--
-- Plan: §25 Phase 2, cantilapay v1.
-- ============================================================

-- ----- enums -----

CREATE TYPE "CantilapayPriceInterval" AS ENUM ('day', 'week', 'month', 'year');

CREATE TYPE "CantilapaySubscriptionStatus" AS ENUM (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid'
);

CREATE TYPE "CantilapayInvoiceStatus" AS ENUM (
    'draft',
    'open',
    'paid',
    'uncollectible',
    'void'
);

-- ----- tables -----

CREATE TABLE "CantilapayProduct" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayProduct_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayProduct_cantilapayAccountId_mode_idx" ON "CantilapayProduct"("cantilapayAccountId", "mode");

CREATE TABLE "CantilapayPrice" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "productId" TEXT NOT NULL,
    "unitAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "recurringInterval" "CantilapayPriceInterval" NOT NULL,
    "recurringIntervalCount" INTEGER NOT NULL DEFAULT 1,
    "trialPeriodDays" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayPrice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayPrice_cantilapayAccountId_mode_idx" ON "CantilapayPrice"("cantilapayAccountId", "mode");
CREATE INDEX "CantilapayPrice_productId_idx" ON "CantilapayPrice"("productId");

CREATE TABLE "CantilapaySubscription" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "customerId" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "defaultPaymentMethodId" TEXT,
    "status" "CantilapaySubscriptionStatus" NOT NULL DEFAULT 'incomplete',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "trialStart" TIMESTAMP(3),
    "trialEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "dunningAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextDunningAt" TIMESTAMP(3),
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapaySubscription_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapaySubscription_cantilapayAccountId_mode_status_idx" ON "CantilapaySubscription"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapaySubscription_currentPeriodEnd_idx" ON "CantilapaySubscription"("currentPeriodEnd");
CREATE INDEX "CantilapaySubscription_nextDunningAt_idx" ON "CantilapaySubscription"("nextDunningAt");
CREATE INDEX "CantilapaySubscription_customerId_idx" ON "CantilapaySubscription"("customerId");

CREATE TABLE "CantilapayInvoice" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "subscriptionId" TEXT,
    "customerId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountDue" INTEGER NOT NULL,
    "amountPaid" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "status" "CantilapayInvoiceStatus" NOT NULL DEFAULT 'draft',
    "finalizedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentIntentId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayInvoice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayInvoice_cantilapayAccountId_mode_status_idx" ON "CantilapayInvoice"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayInvoice_subscriptionId_idx" ON "CantilapayInvoice"("subscriptionId");
CREATE INDEX "CantilapayInvoice_customerId_idx" ON "CantilapayInvoice"("customerId");

CREATE TABLE "CantilapayInvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceId" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayInvoiceItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayInvoiceItem_invoiceId_idx" ON "CantilapayInvoiceItem"("invoiceId");

-- ----- foreign keys -----

ALTER TABLE "CantilapayProduct" ADD CONSTRAINT "CantilapayProduct_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPrice" ADD CONSTRAINT "CantilapayPrice_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPrice" ADD CONSTRAINT "CantilapayPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CantilapayProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapaySubscription" ADD CONSTRAINT "CantilapaySubscription_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapaySubscription" ADD CONSTRAINT "CantilapaySubscription_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "CantilapayPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CantilapayInvoice" ADD CONSTRAINT "CantilapayInvoice_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayInvoice" ADD CONSTRAINT "CantilapayInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CantilapaySubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CantilapayInvoiceItem" ADD CONSTRAINT "CantilapayInvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CantilapayInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

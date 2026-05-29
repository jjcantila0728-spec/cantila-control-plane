-- ============================================================
-- Cantilapay — Phase 1 (Charges) (plan §25).
--
-- Adds Customer, PaymentMethod, PaymentIntent, Refund + 4
-- enums for the one-time-payments state machine. All amounts
-- are integers in MINOR currency units (cents, ören, pence).
--
-- Plan: §25 Phase 1, cantilapay v1.
-- ============================================================

-- ----- enums -----

CREATE TYPE "CantilapayPaymentIntentStatus" AS ENUM (
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'succeeded',
    'canceled',
    'failed'
);

CREATE TYPE "CantilapayCaptureMode" AS ENUM ('automatic', 'manual');

CREATE TYPE "CantilapayPaymentMethodStatus" AS ENUM ('chargeable', 'detached');

CREATE TYPE "CantilapayRefundStatus" AS ENUM ('pending', 'succeeded', 'failed');

-- ----- tables -----

CREATE TABLE "CantilapayCustomer" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "externalRef" TEXT,
    "email" TEXT,
    "name" TEXT,
    "description" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CantilapayCustomer_cantilapayAccountId_mode_externalRef_key" ON "CantilapayCustomer"("cantilapayAccountId", "mode", "externalRef");
CREATE INDEX "CantilapayCustomer_cantilapayAccountId_mode_createdAt_idx" ON "CantilapayCustomer"("cantilapayAccountId", "mode", "createdAt");

CREATE TABLE "CantilapayPaymentMethod" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "customerId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'card',
    "pspToken" TEXT NOT NULL,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpMonth" INTEGER,
    "cardExpYear" INTEGER,
    "status" "CantilapayPaymentMethodStatus" NOT NULL DEFAULT 'chargeable',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detachedAt" TIMESTAMP(3),
    CONSTRAINT "CantilapayPaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayPaymentMethod_cantilapayAccountId_mode_idx" ON "CantilapayPaymentMethod"("cantilapayAccountId", "mode");
CREATE INDEX "CantilapayPaymentMethod_customerId_idx" ON "CantilapayPaymentMethod"("customerId");

CREATE TABLE "CantilapayPaymentIntent" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "customerId" TEXT,
    "paymentMethodId" TEXT,
    "amount" INTEGER NOT NULL,
    "amountCaptured" INTEGER NOT NULL DEFAULT 0,
    "amountRefunded" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "captureMode" "CantilapayCaptureMode" NOT NULL DEFAULT 'automatic',
    "status" "CantilapayPaymentIntentStatus" NOT NULL DEFAULT 'requires_payment_method',
    "platformFeeAmount" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "pspPaymentRef" TEXT,
    "pspSessionData" TEXT,
    "lastError" TEXT,
    "clientIdempotencyKey" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayPaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayPaymentIntent_cantilapayAccountId_mode_status_idx" ON "CantilapayPaymentIntent"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayPaymentIntent_cantilapayAccountId_mode_createdAt_idx" ON "CantilapayPaymentIntent"("cantilapayAccountId", "mode", "createdAt");
CREATE INDEX "CantilapayPaymentIntent_pspPaymentRef_idx" ON "CantilapayPaymentIntent"("pspPaymentRef");
CREATE INDEX "CantilapayPaymentIntent_customerId_idx" ON "CantilapayPaymentIntent"("customerId");

CREATE TABLE "CantilapayRefund" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "CantilapayRefundStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "pspRefundRef" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    CONSTRAINT "CantilapayRefund_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayRefund_cantilapayAccountId_mode_status_idx" ON "CantilapayRefund"("cantilapayAccountId", "mode", "status");
CREATE INDEX "CantilapayRefund_paymentIntentId_idx" ON "CantilapayRefund"("paymentIntentId");
CREATE INDEX "CantilapayRefund_pspRefundRef_idx" ON "CantilapayRefund"("pspRefundRef");

-- ----- foreign keys -----

ALTER TABLE "CantilapayCustomer" ADD CONSTRAINT "CantilapayCustomer_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPaymentMethod" ADD CONSTRAINT "CantilapayPaymentMethod_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPaymentMethod" ADD CONSTRAINT "CantilapayPaymentMethod_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CantilapayCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CantilapayPaymentIntent" ADD CONSTRAINT "CantilapayPaymentIntent_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayPaymentIntent" ADD CONSTRAINT "CantilapayPaymentIntent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "CantilapayCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CantilapayPaymentIntent" ADD CONSTRAINT "CantilapayPaymentIntent_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "CantilapayPaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CantilapayRefund" ADD CONSTRAINT "CantilapayRefund_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayRefund" ADD CONSTRAINT "CantilapayRefund_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "CantilapayPaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Cantilapay — Phase 0 foundation (plan §25 / cantilapay v1).
--
-- Adds the seven Cantilapay* tables and three enums. All names
-- are namespaced so they cannot collide with Cantila's own
-- billing (which stays on Stripe — see Account.stripeCustomerId).
-- The two products are fully separate at the data layer.
--
-- The boot-migration runner (src/domain/boot-migrations.ts)
-- applies this idempotently on control-plane startup until
-- `prisma migrate deploy` is wired in CI.
--
-- Plan: §25 (cantilapay v1), build state v1.18.
-- ============================================================

-- ----- enums -----

CREATE TYPE "CantilapayAccountStatus" AS ENUM ('created', 'onboarding', 'active', 'rejected', 'disabled');
CREATE TYPE "CantilapayApiKeyKind" AS ENUM ('publishable', 'secret');
CREATE TYPE "CantilapayMode" AS ENUM ('test', 'live');

-- ----- tables -----

CREATE TABLE "CantilapayAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "adyenAccountHolderIdTest" TEXT,
    "adyenAccountHolderIdLive" TEXT,
    "status" "CantilapayAccountStatus" NOT NULL DEFAULT 'created',
    "platformFeeBps" INTEGER NOT NULL DEFAULT 50,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CantilapayAccount_accountId_key" ON "CantilapayAccount"("accountId");
CREATE INDEX "CantilapayAccount_accountId_idx" ON "CantilapayAccount"("accountId");

CREATE TABLE "CantilapayApiKey" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CantilapayApiKeyKind" NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayApiKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CantilapayApiKey_hashedKey_key" ON "CantilapayApiKey"("hashedKey");
CREATE INDEX "CantilapayApiKey_cantilapayAccountId_mode_idx" ON "CantilapayApiKey"("cantilapayAccountId", "mode");

CREATE TABLE "CantilapayWebhookEndpoint" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "enabledEvents" TEXT NOT NULL DEFAULT '*',
    "signingSecret" TEXT NOT NULL,
    "signingSecretPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveryAt" TIMESTAMP(3),
    CONSTRAINT "CantilapayWebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayWebhookEndpoint_cantilapayAccountId_mode_idx" ON "CantilapayWebhookEndpoint"("cantilapayAccountId", "mode");

CREATE TABLE "CantilapayEvent" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "type" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayEvent_cantilapayAccountId_mode_createdAt_idx" ON "CantilapayEvent"("cantilapayAccountId", "mode", "createdAt");
CREATE INDEX "CantilapayEvent_type_idx" ON "CantilapayEvent"("type");

CREATE TABLE "CantilapayWebhookDelivery" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lastResponseCode" INTEGER,
    "lastResponseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayWebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayWebhookDelivery_cantilapayAccountId_status_idx" ON "CantilapayWebhookDelivery"("cantilapayAccountId", "status");
CREATE INDEX "CantilapayWebhookDelivery_nextAttemptAt_idx" ON "CantilapayWebhookDelivery"("nextAttemptAt");

CREATE TABLE "CantilapayIdempotencyKey" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" "CantilapayMode" NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CantilapayIdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CantilapayIdempotencyKey_cantilapayAccountId_mode_key_key" ON "CantilapayIdempotencyKey"("cantilapayAccountId", "mode", "key");
CREATE INDEX "CantilapayIdempotencyKey_expiresAt_idx" ON "CantilapayIdempotencyKey"("expiresAt");

CREATE TABLE "CantilapayAuditLog" (
    "id" TEXT NOT NULL,
    "cantilapayAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" TEXT,
    "apiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CantilapayAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CantilapayAuditLog_cantilapayAccountId_createdAt_idx" ON "CantilapayAuditLog"("cantilapayAccountId", "createdAt");

-- ----- foreign keys -----

ALTER TABLE "CantilapayApiKey" ADD CONSTRAINT "CantilapayApiKey_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayWebhookEndpoint" ADD CONSTRAINT "CantilapayWebhookEndpoint_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayEvent" ADD CONSTRAINT "CantilapayEvent_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayWebhookDelivery" ADD CONSTRAINT "CantilapayWebhookDelivery_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayWebhookDelivery" ADD CONSTRAINT "CantilapayWebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "CantilapayWebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayWebhookDelivery" ADD CONSTRAINT "CantilapayWebhookDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "CantilapayEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayIdempotencyKey" ADD CONSTRAINT "CantilapayIdempotencyKey_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CantilapayAuditLog" ADD CONSTRAINT "CantilapayAuditLog_cantilapayAccountId_fkey" FOREIGN KEY ("cantilapayAccountId") REFERENCES "CantilapayAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

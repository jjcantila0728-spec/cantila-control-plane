-- ============================================================
-- DRAFT MIGRATION — add_a2p_registration (plan §4.5 — A2P/10DLC)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `A2pRegistration` table and the two enums backing it. Records the
-- brand + campaign metadata operators must submit to The Campaign
-- Registry before US A2P SMS is allowed at scale; tracks the approval
-- state machine.
--
-- Purely additive — no existing table, column or enum is altered, and
-- there is no FK on accountId (matching the same loose-typed
-- account-id columns `ApiKey.accountId` and `MarketplaceNumber` use
-- when not relating into the Account row directly). Safe to apply to
-- a database that already holds the rest of the schema.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new model.
-- ============================================================

-- CreateEnum
CREATE TYPE "A2pRegistrationKind" AS ENUM ('brand', 'campaign');

-- CreateEnum
CREATE TYPE "A2pRegistrationStatus" AS ENUM ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'hold');

-- CreateTable
CREATE TABLE "A2pRegistration" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "A2pRegistrationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "A2pRegistrationStatus" NOT NULL DEFAULT 'draft',
    "brandRegistrationId" TEXT,
    "payload" JSONB NOT NULL,
    "providerRegistrationId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "A2pRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "A2pRegistration_accountId_kind_idx" ON "A2pRegistration"("accountId", "kind");

-- CreateIndex
CREATE INDEX "A2pRegistration_accountId_status_idx" ON "A2pRegistration"("accountId", "status");

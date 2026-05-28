-- ============================================================
-- DRAFT MIGRATION — add_inbound_mail (plan §4.4 — two-way mail)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `InboundMail` table — persistent message history for inbound mail,
-- the mail counterpart of `InboundMessage` (SMS). Append-only, keyed
-- by accountId / projectId with no FK relation (same shape as
-- `InboundMessage` and `ActivityEvent`).
--
-- Purely additive — no existing table, column or enum is altered.
-- Safe to apply to a database that already holds the rest of the
-- schema.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `InboundMail`.
-- ============================================================

-- CreateTable
CREATE TABLE "InboundMail" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "matchedAliasId" TEXT,
    "routedTo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundMail_projectId_receivedAt_idx" ON "InboundMail"("projectId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundMail_accountId_receivedAt_idx" ON "InboundMail"("accountId", "receivedAt");

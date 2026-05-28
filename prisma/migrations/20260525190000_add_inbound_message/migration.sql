-- ============================================================
-- DRAFT MIGRATION — add_inbound_message (plan §4.5 — persisted
-- inbound SMS message history)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `InboundMessage` table — persisted history of inbound SMS messages
-- received on a project's phone number, the durable record behind
-- two-way SMS. It is an append-only log keyed by accountId / projectId
-- with no foreign-key relation (the same shape as `ActivityEvent`), so
-- it needs no back-relation field on `Account` or `Project`.
--
-- Purely additive: no existing table, column, enum or index is altered,
-- so it is safe to apply to a database that already holds the rest of
-- the schema.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `InboundMessage`. See the earlier draft migrations
-- for the same caveats.
-- ============================================================

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "toE164" TEXT NOT NULL,
    "fromE164" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "keyword" TEXT,
    "providerMessageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundMessage_projectId_receivedAt_idx" ON "InboundMessage"("projectId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundMessage_accountId_receivedAt_idx" ON "InboundMessage"("accountId", "receivedAt");

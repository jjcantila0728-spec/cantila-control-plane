-- ============================================================
-- DRAFT MIGRATION — add_inbound_call (plan §4.5 — persisted inbound
-- voice-call history)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `InboundCallRecord` table — persisted history of inbound voice calls
-- received on a project's phone number, the voice counterpart of
-- `InboundMessage`. An append-only log keyed by accountId / projectId
-- with no foreign-key relation (the `ActivityEvent` / `InboundMessage`
-- shape), so it needs no back-relation field on any other model.
--
-- Purely additive: no existing table, column, enum or index is altered.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `InboundCallRecord`. See the earlier draft migrations
-- for the same caveats.
-- ============================================================

-- CreateTable
CREATE TABLE "InboundCallRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "toE164" TEXT NOT NULL,
    "fromE164" TEXT NOT NULL,
    "providerCallId" TEXT NOT NULL,
    "routingAction" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundCallRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundCallRecord_projectId_receivedAt_idx" ON "InboundCallRecord"("projectId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundCallRecord_accountId_receivedAt_idx" ON "InboundCallRecord"("accountId", "receivedAt");

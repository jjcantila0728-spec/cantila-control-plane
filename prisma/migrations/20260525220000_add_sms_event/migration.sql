-- ============================================================
-- DRAFT MIGRATION — add_sms_event (plan §4.5 / §15 — durable SMS
-- telemetry)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `SmsEvent` table — the persisted backing for the control plane's
-- in-memory SMS event ring, so SMS deliverability history survives a
-- process restart. The in-memory ring stays the fast read path; it is
-- rehydrated from the most recent `SmsEvent` rows on startup.
--
-- Purely additive: no existing table, column, enum or index is altered.
-- The table is append-only and will grow — a periodic prune (or a
-- retention policy) is follow-up work.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `SmsEvent`. See the earlier draft migrations for the
-- same caveats.
-- ============================================================

-- CreateTable
CREATE TABLE "SmsEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "fromE164" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toMasked" TEXT NOT NULL,

    CONSTRAINT "SmsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsEvent_at_idx" ON "SmsEvent"("at");

-- CreateIndex
CREATE INDEX "SmsEvent_accountId_at_idx" ON "SmsEvent"("accountId", "at");

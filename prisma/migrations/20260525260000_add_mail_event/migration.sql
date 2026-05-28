-- ============================================================
-- DRAFT MIGRATION — add_mail_event (plan §4.4 — durable mail telemetry)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `MailEvent` table — the persistent backing for the control plane's
-- in-memory mail event ring, so deliverability history survives a
-- restart. Mirrors `SmsEvent` (migration 20260525220000) for the SMS
-- side; append-only, rehydrated from the most recent N rows on boot.
--
-- Purely additive — no existing table, column or enum is altered, and
-- there is no FK on accountId / projectId (matching the append-only
-- shape `SmsEvent` and `ActivityEvent` already use). Safe to apply to
-- a database that already holds the rest of the schema.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `MailEvent`.
-- ============================================================

-- CreateTable
CREATE TABLE "MailEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "mailboxAddress" TEXT NOT NULL,
    "sendingDomain" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toMasked" TEXT NOT NULL,

    CONSTRAINT "MailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailEvent_at_idx" ON "MailEvent"("at");

-- CreateIndex
CREATE INDEX "MailEvent_accountId_at_idx" ON "MailEvent"("accountId", "at");

-- CreateIndex
CREATE INDEX "MailEvent_sendingDomain_at_idx" ON "MailEvent"("sendingDomain", "at");

-- ============================================================
-- DRAFT MIGRATION — add_mail_ip_pool (plan §4.4 — IP-pool rotation)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `MailIpPool` table and the `MailIpPoolKind` enum. Account-scoped
-- pools the future MTA reads to decide which sending IP an outbound
-- message rides through. Purely additive — no existing table, column
-- or enum is altered. There is no FK on accountId (matches the same
-- loose-typed account-id columns `ApiKey.accountId` and
-- `A2pRegistration.accountId` already use).
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new model.
-- ============================================================

-- CreateEnum
CREATE TYPE "MailIpPoolKind" AS ENUM ('warmup', 'main', 'transactional', 'marketing');

-- CreateTable
CREATE TABLE "MailIpPool" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MailIpPoolKind" NOT NULL DEFAULT 'main',
    "ips" TEXT NOT NULL DEFAULT '',
    "reputation" INTEGER NOT NULL DEFAULT 50,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailIpPool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailIpPool_accountId_idx" ON "MailIpPool"("accountId");

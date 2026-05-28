-- ============================================================
-- DRAFT MIGRATION — add_hosted_mailbox (plan §4.4 — Cantila Mail)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `HostedMailbox` table and the `MailboxKind` enum. It is purely
-- additive — no existing table, column or enum is altered — so it is
-- safe to apply to a database that already holds the rest of the schema.
--
-- Before shipping, do ONE of the following:
--   * Run `prisma migrate dev --name add_hosted_mailbox` so Prisma
--     generates the canonical migration. NOTE: this repo had no
--     prisma/migrations/ folder, so the project was likely on
--     `prisma db push`. Prisma may first want to baseline the existing
--     tables (`prisma migrate diff` → an init migration) so it does not
--     report drift against the already-provisioned schema.
--   * Or run `prisma db push` to apply the schema delta directly with
--     no migration history.
--   * Or apply this SQL by hand and `prisma migrate resolve` it.
--
-- Either way, run `prisma generate` afterwards and `tsc` the control
-- plane so the generated client picks up the new `HostedMailbox` model.
-- ============================================================

-- CreateEnum
CREATE TYPE "MailboxKind" AS ENUM ('personal', 'shared');

-- CreateTable
CREATE TABLE "HostedMailbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "MailboxKind" NOT NULL DEFAULT 'personal',
    "quotaMb" INTEGER NOT NULL DEFAULT 10240,
    "usedMb" INTEGER NOT NULL DEFAULT 0,
    "status" "ServiceStatus" NOT NULL DEFAULT 'provisioning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostedMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostedMailbox_address_key" ON "HostedMailbox"("address");

-- CreateIndex
CREATE INDEX "HostedMailbox_projectId_idx" ON "HostedMailbox"("projectId");

-- AddForeignKey
ALTER TABLE "HostedMailbox" ADD CONSTRAINT "HostedMailbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

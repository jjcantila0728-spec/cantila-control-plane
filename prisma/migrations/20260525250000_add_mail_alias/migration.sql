-- ============================================================
-- DRAFT MIGRATION — add_mail_alias (plan §4.4 — Cantila Mail aliases)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `MailAlias` table and the `MailAliasKind` enum that back the
-- forwarding / catch-all / parse routing rules. Mirrors the Console's
-- existing `MailAlias` shape (cantila-console/src/lib/types.ts) so the
-- live wiring drops into the existing UI without surface changes.
--
-- Purely additive — no existing table, column or enum is altered. The
-- table is project-scoped with an FK + cascade matching how
-- HostedMailbox attaches to Project.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new model.
-- ============================================================

-- CreateEnum
CREATE TYPE "MailAliasKind" AS ENUM ('alias', 'forward', 'catch_all', 'parse');

-- CreateTable
CREATE TABLE "MailAlias" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "kind" "MailAliasKind" NOT NULL DEFAULT 'alias',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailAlias_address_key" ON "MailAlias"("address");

-- CreateIndex
CREATE INDEX "MailAlias_projectId_idx" ON "MailAlias"("projectId");

-- AddForeignKey
ALTER TABLE "MailAlias" ADD CONSTRAINT "MailAlias_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

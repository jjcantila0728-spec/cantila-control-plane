-- ============================================================
-- DRAFT MIGRATION — add_account_parent (plan §5.5 — white-label /
-- reseller)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a
-- nullable `parentAccountId` column to `Account` so a row can be a
-- sub-account under an agency / reseller parent. Top-level accounts
-- leave the column NULL, so the migration is purely additive and
-- existing rows backfill cleanly with no application-level work.
--
-- No FK constraint (matches the loose-typed account-id columns
-- elsewhere in this schema — `ApiKey.accountId`, `MailIpPool.accountId`,
-- the new `Node.accountId`). Cross-account assertions live at the
-- ControlPlane layer (`canActOnAccount`).
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane.
-- ============================================================

-- AlterTable
ALTER TABLE "Account" ADD COLUMN "parentAccountId" TEXT;

-- CreateIndex
CREATE INDEX "Account_parentAccountId_idx" ON "Account"("parentAccountId");

-- ============================================================
-- DRAFT MIGRATION — add_invite (plan §5.4 — per-user invite flow)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `Invite` table and the `InviteStatus` enum that back the per-user
-- invite flow — replacing the prototype's "every new user joins the
-- bootstrap account" hack with a one-time accept link that pins the
-- new user to the inviting account.
--
-- Purely additive — no existing table, column or enum is altered, and
-- there is no FK on `accountId` (matching the same loose-typed
-- account-id columns `ApiKey.accountId` and `User.accountId` already
-- use). Safe to apply to a database that already holds the rest of
-- the schema.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new model.
-- ============================================================

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'developer',
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "invitedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_accountId_status_idx" ON "Invite"("accountId", "status");

-- CreateIndex
CREATE INDEX "Invite_email_idx" ON "Invite"("email");

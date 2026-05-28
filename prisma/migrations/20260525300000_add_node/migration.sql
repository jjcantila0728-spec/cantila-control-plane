-- ============================================================
-- DRAFT MIGRATION — add_node (plan §5.5 — Bring-Your-Own-VPS)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `Node` table and the `NodeKind` / `NodeStatus` enums. A row
-- represents one compute node the control plane can schedule
-- workloads on — either Cantila-managed (`kind = managed`) or
-- tenant-supplied via BYO-VPS (`kind = byo`). Purely additive — no
-- existing table, column or enum is altered. There is no FK on
-- accountId (matches `ApiKey.accountId` / `MailIpPool.accountId`'s
-- loose-typed approach, so account isolation is enforced at the CP
-- layer rather than at the schema layer).
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up the new model.
-- ============================================================

-- CreateEnum
CREATE TYPE "NodeKind" AS ENUM ('managed', 'byo');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('pending', 'active', 'degraded', 'offline', 'retired');

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" "NodeKind" NOT NULL DEFAULT 'byo',
    "label" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "enrollmentTokenHash" TEXT NOT NULL,
    "enrollmentTokenPrefix" TEXT NOT NULL,
    "publicKeyFingerprint" TEXT,
    "capacityInstances" INTEGER NOT NULL DEFAULT 16,
    "status" "NodeStatus" NOT NULL DEFAULT 'pending',
    "reportedInstances" INTEGER,
    "reportedLoadPct" INTEGER,
    "enrolledAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Node_accountId_idx" ON "Node"("accountId");

-- CreateIndex
CREATE INDEX "Node_enrollmentTokenHash_idx" ON "Node"("enrollmentTokenHash");

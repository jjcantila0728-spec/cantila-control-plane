-- ============================================================
-- DRAFT MIGRATION — add_activity_actor (plan §5.5 — white-label
-- per-event audit threading).
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds a
-- nullable `actorAccountId` column to `ActivityEvent` so an event
-- driven by an agency parent against a sub-account can record both
-- the target (`accountId`) and the actor (`actorAccountId`). Legacy
-- rows backfill to NULL, which is read as "the account itself drove
-- this" — fully backward-compatible.
--
-- The new `Index([actorAccountId])` lets the future per-actor audit
-- view ("everything acc_agency1 did across every sub-account") hit
-- an index instead of full-scanning.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane.
-- ============================================================

-- AlterTable
ALTER TABLE "ActivityEvent" ADD COLUMN "actorAccountId" TEXT;

-- CreateIndex
CREATE INDEX "ActivityEvent_actorAccountId_idx" ON "ActivityEvent"("actorAccountId");

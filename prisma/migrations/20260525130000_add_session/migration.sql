-- ============================================================
-- DRAFT MIGRATION — add_session (plan §5.4 — per-user OIDC/SSO auth)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `Session` table that backs the Console's per-user login. It is purely
-- additive — no existing table, column or enum is altered — so it is
-- safe to apply to a database that already holds the rest of the schema.
--
-- The `User` model it references already exists. Before shipping, run
-- `prisma migrate dev` (or `prisma db push`) + `prisma generate`, then
-- `tsc` the control plane so the generated client picks up `Session`.
-- See prisma/migrations/20260525120000_add_hosted_mailbox for the same
-- caveats around this repo not previously having a migrations folder.
-- ============================================================

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

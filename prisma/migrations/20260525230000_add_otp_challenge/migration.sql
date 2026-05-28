-- ============================================================
-- DRAFT MIGRATION — add_otp_challenge (plan §4.5 / §15 — durable OTP
-- challenges)
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds the
-- `OtpChallenge` table — the persisted backing for the control plane's
-- in-memory OTP challenge map, so an in-flight phone verification
-- survives a process restart. The in-memory map stays the fast path; it
-- is rehydrated from this table on startup, and the control-plane TTL
-- sweep prunes expired rows here as well as in memory.
--
-- `codeHash` is a salted SHA-256 digest — the OTP code itself is never
-- stored, in memory or on disk.
--
-- Purely additive: no existing table, column, enum or index is altered.
--
-- Before shipping, run `prisma migrate dev` (or `prisma db push`) +
-- `prisma generate`, then `tsc` the control plane so the generated
-- client picks up `OtpChallenge`. See the earlier draft migrations for
-- the same caveats.
-- ============================================================

-- CreateTable
CREATE TABLE "OtpChallenge" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneMasked" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,

    CONSTRAINT "OtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtpChallenge_createdAt_idx" ON "OtpChallenge"("createdAt");

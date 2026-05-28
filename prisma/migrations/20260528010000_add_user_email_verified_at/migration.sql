-- ============================================================
-- DRAFT MIGRATION — add_user_email_verified_at (v1.18).
--
-- Adds `User.emailVerifiedAt` to back the email-verify one-shot
-- token flow (plan §5.4). The control plane stamps this column
-- on a successful `POST /v1/auth/verify-email/confirm`; absent
-- on legacy rows reads as unverified.
--
-- Nullable so the column add is non-blocking against the live
-- table — the boot-migration runner (src/domain/boot-migrations.ts)
-- applies the same ALTER on control-plane startup until
-- `prisma migrate deploy` is wired (plan §15.7 follow-up).
--
-- Plan: §5.4, §15.1, v1.18.
-- ============================================================

ALTER TABLE "User"
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

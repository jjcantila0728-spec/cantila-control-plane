-- ============================================================
-- DRAFT MIGRATION — add_project_coolify_app_uuid.
--
-- Hand-authored and NOT yet run through `prisma migrate`. Adds the
-- single `coolifyAppUuid` column on `Project` so the live Coolify
-- data plane (`CoolifyDataPlane`) can persist the Cantila Project →
-- Coolify Application UUID mapping across restarts without a full
-- `/applications` rescan on first deploy of every project.
--
-- Nullable so existing rows (created on the stub data plane or
-- before this column existed) keep working unchanged — the value
-- gets backfilled the next time the live data plane runs through
-- `startContainer()` for each project.
--
-- Plan: §15.1, §19.
-- ============================================================

ALTER TABLE "Project"
  ADD COLUMN "coolifyAppUuid" TEXT;

-- ============================================================
-- DRAFT MIGRATION — add_project_brain_and_assets.
--
-- Hand-authored and NOT yet verified by `prisma migrate`. Adds:
--   1. Per-account project-name uniqueness so /@handle/<name> resolves.
--   2. Per-project chat history (ProjectMessage) — the user's
--      conversation with the project's agent team.
--   3. Per-project rolling memory (ProjectMemory) — the LLM-written
--      summary that acts as the cached prompt prefix, so subsequent
--      turns stay token-cheap (Anthropic prompt cache).
--   4. Per-project asset catalogue (ProjectAsset) — every generated
--      image / icon / lottie / video / file produced by the build
--      agents, surfaced in the workspace's AssetGallery.
--
-- Legacy rows: existing projects with name collisions inside the
-- same account will fail the unique index. There are none in seed
-- today, but the production rollout must run the dedupe pre-step
-- below before applying the index.
--
-- Before shipping, run `prisma migrate dev` + `prisma generate`,
-- then `tsc` the control plane.
-- ============================================================

-- Per-account project-name uniqueness.
CREATE UNIQUE INDEX "Project_accountId_name_key" ON "Project"("accountId", "name");

-- Enums for the chat + asset models.
CREATE TYPE "ProjectMessageRole" AS ENUM ('user', 'agent', 'system', 'tool');
CREATE TYPE "ProjectMessageKind" AS ENUM ('message', 'op_card', 'result', 'asset');
CREATE TYPE "ProjectAssetKind"   AS ENUM ('image', 'icon', 'lottie', 'css_anim', 'video', 'copy', 'file');

-- Per-project chat thread.
CREATE TABLE "ProjectMessage" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role"      "ProjectMessageRole" NOT NULL,
    "agent"     TEXT,
    "kind"      "ProjectMessageKind" NOT NULL DEFAULT 'message',
    "content"   TEXT NOT NULL,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProjectMessage_projectId_createdAt_idx" ON "ProjectMessage"("projectId", "createdAt");
ALTER TABLE "ProjectMessage" ADD CONSTRAINT "ProjectMessage_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-project rolling memory (one row per project).
CREATE TABLE "ProjectMemory" (
    "projectId"               TEXT NOT NULL,
    "summary"                 TEXT NOT NULL DEFAULT '',
    "lastSummarizedMessageId" TEXT,
    "tokenCount"              INTEGER NOT NULL DEFAULT 0,
    "updatedAt"               TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectMemory_pkey" PRIMARY KEY ("projectId")
);
ALTER TABLE "ProjectMemory" ADD CONSTRAINT "ProjectMemory_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-project asset catalogue.
CREATE TABLE "ProjectAsset" (
    "id"        TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind"      "ProjectAssetKind" NOT NULL,
    "path"      TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL,
    "width"     INTEGER,
    "height"    INTEGER,
    "prompt"    TEXT,
    "provider"  TEXT NOT NULL DEFAULT 'stub',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProjectAsset_projectId_createdAt_idx" ON "ProjectAsset"("projectId", "createdAt");
CREATE INDEX "ProjectAsset_projectId_kind_idx" ON "ProjectAsset"("projectId", "kind");
ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

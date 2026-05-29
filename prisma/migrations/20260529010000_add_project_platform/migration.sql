-- Project.platform — marks the seeded hidden Platform project that owns
-- cantila.app (plan §4.4). New column with a default; existing rows get false.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "platform" BOOLEAN NOT NULL DEFAULT false;

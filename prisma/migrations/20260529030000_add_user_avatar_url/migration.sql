-- Add nullable avatar URL for social sign-in profile pictures.
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;

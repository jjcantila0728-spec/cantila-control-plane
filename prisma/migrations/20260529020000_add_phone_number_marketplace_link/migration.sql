-- PhoneNumber.marketplaceNumberId — links a project's SMS number to the
-- account-owned MarketplaceNumber it was provisioned from when SMS was
-- activated (opt-in, plan §4.5). deactivateSms releases that number.
-- Nullable; legacy rows stay null.
ALTER TABLE "PhoneNumber" ADD COLUMN IF NOT EXISTS "marketplaceNumberId" TEXT;

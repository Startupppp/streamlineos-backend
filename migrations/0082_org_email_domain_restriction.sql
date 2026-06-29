-- Org-level email domain restriction for sign-ups
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "allowed_email_domains" text[] DEFAULT ARRAY[]::text[];

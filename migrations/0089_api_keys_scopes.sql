-- Add scopes array to api_keys table to define allowed modules/actions per key
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" text[] NOT NULL DEFAULT '{}';

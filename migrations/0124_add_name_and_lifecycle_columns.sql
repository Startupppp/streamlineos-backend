-- Idempotent: adds name + lifecycle columns that may be missing from DB.

-- name column on users (single display name)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "name" text;

-- Status lifecycle columns (from 0123 in case it wasn't applied)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "user_status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "invited_at" timestamp,
  ADD COLUMN IF NOT EXISTS "activated_at" timestamp,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp,
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;

-- Profile columns (from 0123 in case it wasn't applied)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "first_name" text,
  ADD COLUMN IF NOT EXISTS "last_name" text,
  ADD COLUMN IF NOT EXISTS "is_profile_picture_required" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "bio" text,
  ADD COLUMN IF NOT EXISTS "linkedin_url" text,
  ADD COLUMN IF NOT EXISTS "twitter_url" text,
  ADD COLUMN IF NOT EXISTS "github_url" text,
  ADD COLUMN IF NOT EXISTS "website_url" text,
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp;

-- Ensure the onboarding_doc_status enum exists
DO $$ BEGIN
  CREATE TYPE "onboarding_doc_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Onboarding doc status column (from 0123 in case it wasn't applied)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_doc_status" "onboarding_doc_status" NOT NULL DEFAULT 'PENDING';

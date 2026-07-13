ALTER TABLE "feedbucket_submissions"
  ADD COLUMN IF NOT EXISTS "ai_type" text,
  ADD COLUMN IF NOT EXISTS "ai_confidence" integer,
  ADD COLUMN IF NOT EXISTS "ai_analysis" jsonb,
  ADD COLUMN IF NOT EXISTS "ai_model" text,
  ADD COLUMN IF NOT EXISTS "ai_processed_at" timestamp;

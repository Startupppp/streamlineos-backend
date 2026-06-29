-- Add AI scoring columns to candidates table
ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "resume_text" TEXT,
  ADD COLUMN IF NOT EXISTS "ai_score" INTEGER,
  ADD COLUMN IF NOT EXISTS "ai_score_breakdown" JSONB,
  ADD COLUMN IF NOT EXISTS "ai_score_generated_at" TIMESTAMP;

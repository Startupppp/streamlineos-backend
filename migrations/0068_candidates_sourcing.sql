ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "external_id" TEXT;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "duplicate_of_id" INTEGER;
ALTER TABLE "job_postings" ADD COLUMN IF NOT EXISTS "closing_date" TIMESTAMP;

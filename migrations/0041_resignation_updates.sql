-- Add new values to resignation_status enum (Postgres requires this approach)
ALTER TYPE resignation_status ADD VALUE IF NOT EXISTS 'PENDING_HR';
ALTER TYPE resignation_status ADD VALUE IF NOT EXISTS 'HR_APPROVED';
ALTER TYPE resignation_status ADD VALUE IF NOT EXISTS 'CEO_APPROVED';
ALTER TYPE resignation_status ADD VALUE IF NOT EXISTS 'IN_PROGRESS';

-- Add new columns to resignations table
ALTER TABLE "resignations"
  ADD COLUMN IF NOT EXISTS "reason_category" text,
  ADD COLUMN IF NOT EXISTS "resignation_letter_url" text,
  ADD COLUMN IF NOT EXISTS "hr_reviewed_by" text REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "hr_reviewed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "hr_remarks" text,
  ADD COLUMN IF NOT EXISTS "ceo_reviewed_by" text REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "ceo_reviewed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "ceo_remarks" text,
  ADD COLUMN IF NOT EXISTS "willing_for_exit_interview" boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS "company_feedback" text;

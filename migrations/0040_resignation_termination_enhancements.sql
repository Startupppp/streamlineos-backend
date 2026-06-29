-- Migration: Resignation & Termination Flow Enhancements
-- Adds new resignation statuses, termination table, and resignation table columns

-- Update resignation_status enum with new values
ALTER TYPE "resignation_status" ADD VALUE IF NOT EXISTS 'PENDING_HR';
ALTER TYPE "resignation_status" ADD VALUE IF NOT EXISTS 'HR_APPROVED';
ALTER TYPE "resignation_status" ADD VALUE IF NOT EXISTS 'CEO_APPROVED';
ALTER TYPE "resignation_status" ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
ALTER TYPE "resignation_status" ADD VALUE IF NOT EXISTS 'REJECTED';

-- Create termination_status enum
DO $$ BEGIN
  CREATE TYPE "termination_status" AS ENUM ('DRAFT', 'PENDING_CEO', 'APPROVED', 'REJECTED', 'SENT', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add new columns to resignations table
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "reason_category" text;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "resignation_letter_url" text;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "hr_reviewed_by" text REFERENCES "users"("id");
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "hr_reviewed_at" timestamp;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "hr_remarks" text;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "ceo_reviewed_by" text REFERENCES "users"("id");
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "ceo_reviewed_at" timestamp;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "ceo_remarks" text;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "willing_for_exit_interview" boolean DEFAULT true;
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "company_feedback" text;

-- Create terminations table
CREATE TABLE IF NOT EXISTS "terminations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "reasons" text[],
  "detailed_explanation" text,
  "effective_date" date,
  "severance_amount" numeric,
  "notice_period_waived" boolean DEFAULT false,
  "termination_letter_url" text,
  "supporting_doc_urls" text[],
  "internal_notes" text,
  "status" "termination_status" DEFAULT 'DRAFT',
  "initiated_by" text REFERENCES "users"("id"),
  "ceo_reviewed_by" text REFERENCES "users"("id"),
  "ceo_reviewed_at" timestamp,
  "ceo_remarks" text,
  "email_sent_at" timestamp,
  "email_status" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_terminations_org" ON "terminations" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_terminations_user" ON "terminations" ("user_id");

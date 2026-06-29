-- Comprehensive catch-up migration for all potentially missing columns
-- Uses IF NOT EXISTS to be safe to run multiple times

-- Users table columns
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_refresh_token" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bio" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "linkedin_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twitter_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "website_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "login_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "has_dashboard_access" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reporting_to" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "team" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "branch_id" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emergency_contact" jsonb;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_number" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "whatsapp_same_as_phone" boolean DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_salary" numeric;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "employee_id" text;

-- onboarding_doc_status enum + columns (may fail if enum exists, that's OK)
DO $$ BEGIN
  CREATE TYPE onboarding_doc_status AS ENUM ('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_profile_picture_required" boolean DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_doc_status" text DEFAULT 'PENDING';

-- Organizations columns
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "mfa_enforced" boolean DEFAULT false NOT NULL;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "password_expiry_days" integer;

-- Candidates diversity columns
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "location" text;
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "gender" text;

-- Interviews panel + recording columns
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "panel_interviewer_ids" jsonb DEFAULT '[]';
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "recording_url" text;
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "recording_platform" text;

-- Landing page settings
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "settings" jsonb;

-- Leads UTM columns
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_source" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_medium" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_content" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_term" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ip_address" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "referrer_url" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "merged_into_id" integer;

-- Interview booking links table
CREATE TABLE IF NOT EXISTS "interview_booking_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "token" text NOT NULL UNIQUE,
  "interviewer_ids" jsonb NOT NULL DEFAULT '[]',
  "duration_minutes" integer NOT NULL DEFAULT 60,
  "interview_type" text NOT NULL DEFAULT 'VIDEO',
  "available_slots" jsonb NOT NULL DEFAULT '[]',
  "selected_slot" timestamp,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_booking_links_token" ON "interview_booking_links"("token");
CREATE INDEX IF NOT EXISTS "idx_booking_links_candidate" ON "interview_booking_links"("candidate_id");

-- Calibration sessions table
CREATE TABLE IF NOT EXISTS "calibration_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "scheduled_at" timestamp,
  "status" text NOT NULL DEFAULT 'pending',
  "notes" text,
  "decision" text,
  "participant_ids" jsonb NOT NULL DEFAULT '[]',
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_calibration_sessions_candidate" ON "calibration_sessions"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_calibration_sessions_org" ON "calibration_sessions"("org_id");

-- Candidate referrals table
CREATE TABLE IF NOT EXISTS "candidate_referrals" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "referred_by" text NOT NULL REFERENCES "users"("id"),
  "relationship" text,
  "notes" text,
  "bonus_eligible" boolean NOT NULL DEFAULT true,
  "bonus_amount" numeric(12,2),
  "bonus_paid_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_referrals_candidate" ON "candidate_referrals"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_referrals_referred_by" ON "candidate_referrals"("referred_by");

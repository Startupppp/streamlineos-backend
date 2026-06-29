-- Recruitment enums
DO $$ BEGIN
  CREATE TYPE "job_posting_status" AS ENUM ('DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'FILLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "candidate_status" AS ENUM ('NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "interview_type" AS ENUM ('PHONE', 'VIDEO', 'ONSITE', 'TECHNICAL', 'HR', 'FINAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "interview_result" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "application_status" AS ENUM ('APPLIED', 'SHORTLISTED', 'INTERVIEWING', 'OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Job Postings
CREATE TABLE IF NOT EXISTS "job_postings" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "department_id" integer REFERENCES "departments"("id"),
  "location" text,
  "type" text DEFAULT 'FULL_TIME',
  "experience" text,
  "salary_min" decimal,
  "salary_max" decimal,
  "description" text,
  "requirements" text,
  "benefits" text,
  "status" "job_posting_status" DEFAULT 'DRAFT',
  "openings" integer DEFAULT 1,
  "application_deadline" date,
  "posted_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_job_postings_org" ON "job_postings" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_job_postings_status" ON "job_postings" ("status");

-- Candidates
CREATE TABLE IF NOT EXISTS "candidates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text,
  "resume_url" text,
  "linkedin_url" text,
  "portfolio_url" text,
  "current_company" text,
  "current_role" text,
  "experience_years" decimal,
  "skills" text[],
  "source" text DEFAULT 'DIRECT',
  "status" "candidate_status" DEFAULT 'NEW',
  "notes" text,
  "rating" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_candidates_org" ON "candidates" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_candidates_status" ON "candidates" ("status");
CREATE INDEX IF NOT EXISTS "idx_candidates_email" ON "candidates" ("email");

-- Candidate Applications
CREATE TABLE IF NOT EXISTS "candidate_applications" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer NOT NULL REFERENCES "job_postings"("id") ON DELETE CASCADE,
  "status" "application_status" DEFAULT 'APPLIED',
  "applied_at" timestamp DEFAULT now(),
  "cover_letter" text,
  "notes" text,
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_applications_candidate" ON "candidate_applications" ("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_applications_job" ON "candidate_applications" ("job_posting_id");

-- Interviews
CREATE TABLE IF NOT EXISTS "interviews" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "interviewer_id" text REFERENCES "users"("id"),
  "type" "interview_type" DEFAULT 'VIDEO',
  "scheduled_at" timestamp NOT NULL,
  "duration" integer DEFAULT 60,
  "location" text,
  "meeting_link" text,
  "result" "interview_result" DEFAULT 'PENDING',
  "feedback" text,
  "rating" integer,
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_interviews_candidate" ON "interviews" ("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_interviews_interviewer" ON "interviews" ("interviewer_id");
CREATE INDEX IF NOT EXISTS "idx_interviews_scheduled" ON "interviews" ("scheduled_at");

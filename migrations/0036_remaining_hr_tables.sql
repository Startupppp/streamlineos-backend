DO $$ BEGIN CREATE TYPE "feedback_type" AS ENUM ('SELF', 'PEER', 'MANAGER', 'SKIP_LEVEL'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "bonus_type" AS ENUM ('PERFORMANCE', 'FESTIVAL', 'REFERRAL', 'SPOT', 'ANNUAL'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "fnf_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "feedback_requests" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "subject_user_id" text NOT NULL REFERENCES "users"("id"),
  "reviewer_user_id" text NOT NULL REFERENCES "users"("id"),
  "type" "feedback_type" NOT NULL,
  "cycle_id" integer REFERENCES "review_cycles"("id"),
  "ratings" jsonb,
  "strengths" text,
  "improvements" text,
  "overall_rating" integer,
  "is_completed" boolean DEFAULT false,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_feedback_subject" ON "feedback_requests" ("subject_user_id");
CREATE INDEX IF NOT EXISTS "idx_feedback_reviewer" ON "feedback_requests" ("reviewer_user_id");

CREATE TABLE IF NOT EXISTS "hr_email_templates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "name" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "category" text DEFAULT 'GENERAL',
  "variables" text[],
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_email_templates_org" ON "hr_email_templates" ("org_id");

CREATE TABLE IF NOT EXISTS "career_ladders" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "department" text,
  "levels" jsonb,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_career_ladders_org" ON "career_ladders" ("org_id");

CREATE TABLE IF NOT EXISTS "bonuses" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "type" "bonus_type" NOT NULL,
  "amount" decimal NOT NULL,
  "reason" text,
  "month" text,
  "status" text DEFAULT 'PENDING',
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_bonuses_user" ON "bonuses" ("user_id");

CREATE TABLE IF NOT EXISTS "fnf_settlements" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "resignation_id" integer REFERENCES "resignations"("id"),
  "basic_dues" decimal DEFAULT 0,
  "leave_encashment" decimal DEFAULT 0,
  "bonus_due" decimal DEFAULT 0,
  "deductions" decimal DEFAULT 0,
  "loan_recovery" decimal DEFAULT 0,
  "net_payable" decimal DEFAULT 0,
  "status" "fnf_status" DEFAULT 'DRAFT',
  "approved_by" text REFERENCES "users"("id"),
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_fnf_user" ON "fnf_settlements" ("user_id");

CREATE TABLE IF NOT EXISTS "asset_returns" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "asset_id" integer REFERENCES "assets"("id"),
  "asset_name" text NOT NULL,
  "status" text DEFAULT 'PENDING',
  "returned_at" timestamp,
  "condition" text,
  "notes" text,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_asset_returns_user" ON "asset_returns" ("user_id");

CREATE TABLE IF NOT EXISTS "alumni_profiles" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "current_company" text,
  "current_role" text,
  "linkedin_url" text,
  "email" text,
  "left_date" date,
  "is_opted_in" boolean DEFAULT true,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_alumni_org" ON "alumni_profiles" ("org_id");

CREATE TABLE IF NOT EXISTS "enps_scores" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text REFERENCES "users"("id"),
  "score" integer NOT NULL,
  "comment" text,
  "is_anonymous" boolean DEFAULT true,
  "period" text,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_enps_org_period" ON "enps_scores" ("org_id", "period");

CREATE TABLE IF NOT EXISTS "handbook_versions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "version" text NOT NULL,
  "document_id" integer REFERENCES "rich_documents"("id"),
  "changelog" text,
  "published_at" timestamp,
  "published_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_handbook_org" ON "handbook_versions" ("org_id");

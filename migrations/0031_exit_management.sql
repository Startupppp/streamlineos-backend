DO $$ BEGIN
  CREATE TYPE "resignation_status" AS ENUM ('SUBMITTED', 'APPROVED', 'WITHDRAWN', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "exit_checklist_status" AS ENUM ('PENDING', 'DONE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "resignations" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "reason" text,
  "last_working_date" date,
  "notice_period_days" integer DEFAULT 30,
  "status" "resignation_status" DEFAULT 'SUBMITTED',
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "exit_interview_notes" text,
  "exit_interview_date" timestamp,
  "exit_interview_conducted_by" text REFERENCES "users"("id"),
  "feedback" jsonb,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_resignations_org" ON "resignations" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_resignations_user" ON "resignations" ("user_id");

CREATE TABLE IF NOT EXISTS "exit_checklists" (
  "id" serial PRIMARY KEY,
  "resignation_id" integer NOT NULL REFERENCES "resignations"("id") ON DELETE CASCADE,
  "item" text NOT NULL,
  "assigned_to" text REFERENCES "users"("id"),
  "status" "exit_checklist_status" DEFAULT 'PENDING',
  "completed_at" timestamp,
  "notes" text
);

DO $$ BEGIN CREATE TYPE "pip_status" AS ENUM ('ACTIVE', 'EXTENDED', 'COMPLETED', 'TERMINATED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "survey_status" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "performance_improvement_plans" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "manager_id" text NOT NULL REFERENCES "users"("id"),
  "reason" text NOT NULL,
  "objectives" jsonb,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "status" "pip_status" DEFAULT 'ACTIVE',
  "outcome" text,
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_pip_user" ON "performance_improvement_plans" ("user_id");

CREATE TABLE IF NOT EXISTS "key_results" (
  "id" serial PRIMARY KEY,
  "goal_id" integer NOT NULL REFERENCES "goals"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "target_value" decimal,
  "current_value" decimal DEFAULT 0,
  "unit" text,
  "progress" integer DEFAULT 0,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_key_results_goal" ON "key_results" ("goal_id");

CREATE TABLE IF NOT EXISTS "employee_skills" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "skill_name" text NOT NULL,
  "level" integer DEFAULT 1,
  "verified_by" text REFERENCES "users"("id"),
  "verified_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_employee_skills_user" ON "employee_skills" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_employee_skills_name" ON "employee_skills" ("skill_name");

CREATE TABLE IF NOT EXISTS "pulse_surveys" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "title" text NOT NULL,
  "questions" jsonb,
  "status" "survey_status" DEFAULT 'DRAFT',
  "is_anonymous" boolean DEFAULT true,
  "created_by" text REFERENCES "users"("id"),
  "closes_at" timestamp,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_surveys_org" ON "pulse_surveys" ("org_id");

CREATE TABLE IF NOT EXISTS "survey_responses" (
  "id" serial PRIMARY KEY,
  "survey_id" integer NOT NULL REFERENCES "pulse_surveys"("id") ON DELETE CASCADE,
  "user_id" text REFERENCES "users"("id"),
  "answers" jsonb,
  "submitted_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_survey_responses_survey" ON "survey_responses" ("survey_id");

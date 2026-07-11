-- Migration 0217: HR Forms and Submissions
-- Idempotent — safe to re-run

DO $$ BEGIN
  CREATE TYPE hr_form_status AS ENUM ('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_form_audience AS ENUM ('internal', 'public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_form_submission_status AS ENUM ('submitted', 'in_review', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "hr_forms" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "status" hr_form_status NOT NULL DEFAULT 'draft',
  "audience" hr_form_audience NOT NULL DEFAULT 'internal',
  "workflow_object_type" text,
  "schema" jsonb NOT NULL DEFAULT '[]',
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "updated_at" timestamp NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_forms_org_name" ON "hr_forms"("org_id", "name") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_forms_org_slug" ON "hr_forms"("org_id", "slug") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_hr_forms_org_status" ON "hr_forms"("org_id", "status");

CREATE TABLE IF NOT EXISTS "hr_form_submissions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "form_id" integer NOT NULL REFERENCES "hr_forms"("id") ON DELETE CASCADE,
  "form_schema_snapshot" jsonb NOT NULL,
  "submitted_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "submitted_by_name" text,
  "subject_employee_id" integer,
  "data" jsonb NOT NULL DEFAULT '{}',
  "status" hr_form_submission_status NOT NULL DEFAULT 'submitted',
  "workflow_instance_id" integer,
  "created_at" timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_hr_form_subs_org_form_created" ON "hr_form_submissions"("org_id", "form_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_hr_form_subs_org_status" ON "hr_form_submissions"("org_id", "status");

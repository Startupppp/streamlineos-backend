-- 0166_project_forms.sql
-- Project Forms builder + Submissions engine: 2 enum types + 2 tables with indexes.
-- Hand-authored; NOT applied by this session. Apply via psql or db:migrate in a TTY.
-- Chosen number: 0166 (0165 is taken by 0165_project_incidents.sql).
-- Enum names form_type and form_submission_status are free in enums.ts; no collision.

DO $$ BEGIN CREATE TYPE "public"."form_type" AS ENUM('task_request','bug_report','feature_request','change_request','client_approval','risk_report','qa_issue','generic'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."form_submission_status" AS ENUM('submitted','processed','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "project_forms" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "form_number" integer NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "type" "form_type" NOT NULL DEFAULT 'generic',
  "fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "actions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "is_public" boolean NOT NULL DEFAULT false,
  "public_token" text,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_project_forms_org_project" ON "project_forms" ("org_id", "project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_project_forms_project_number" ON "project_forms" ("project_id", "form_number");
CREATE INDEX IF NOT EXISTS "idx_project_forms_public_token" ON "project_forms" ("public_token");

CREATE TABLE IF NOT EXISTS "form_submissions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "form_id" integer NOT NULL REFERENCES "project_forms"("id") ON DELETE CASCADE,
  "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "values" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" "form_submission_status" NOT NULL DEFAULT 'submitted',
  "submitted_by_name" text,
  "submitted_by_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "converted_ticket_id" integer REFERENCES "tickets"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_form_submissions_form" ON "form_submissions" ("form_id");
CREATE INDEX IF NOT EXISTS "idx_form_submissions_org_project_status" ON "form_submissions" ("org_id", "project_id", "status");

DO $$ BEGIN
  CREATE TYPE "hr_template_kind" AS ENUM (
    'onboarding_checklist', 'offboarding_checklist', 'probation_review',
    'performance_review', 'goal', 'letter', 'document_request', 'email',
    'notification', 'survey', 'training', 'asset_assignment', 'exit_interview'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_template_status" AS ENUM (
    'draft', 'review', 'approved', 'active', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_letter_type" AS ENUM (
    'offer', 'appointment', 'confirmation', 'promotion', 'transfer',
    'salary_revision', 'warning', 'experience', 'relieving', 'termination'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "hr_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" "hr_template_kind" NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" "hr_template_status" DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "parent_template_id" integer REFERENCES "hr_templates"("id") ON DELETE SET NULL,
  "content" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "variables_used" text[] DEFAULT '{}' NOT NULL,
  "letter_type" "hr_letter_type",
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "updated_by" text REFERENCES "users"("id"),
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "hr_template_renders" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "template_id" integer NOT NULL REFERENCES "hr_templates"("id") ON DELETE CASCADE,
  "template_version" integer NOT NULL,
  "rendered_for_employee_id" integer,
  "rendered_by" text NOT NULL REFERENCES "users"("id"),
  "context_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output_html" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_templates_org_kind_name_ver"
  ON "hr_templates"("org_id", "kind", "name", "version");

CREATE INDEX IF NOT EXISTS "idx_hr_templates_org_kind"
  ON "hr_templates"("org_id", "kind");

CREATE INDEX IF NOT EXISTS "idx_hr_templates_org_status"
  ON "hr_templates"("org_id", "status");

CREATE INDEX IF NOT EXISTS "idx_hr_template_renders_org_template"
  ON "hr_template_renders"("org_id", "template_id", "created_at" DESC);

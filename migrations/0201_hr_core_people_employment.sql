-- HR Core People & Employment Layer
-- Tables: hr_people, hr_employments, hr_employee_profiles, hr_employee_sensitive_fields,
--         hr_employment_history, hr_effective_dated_changes, hr_reporting_lines,
--         hr_job_roles, hr_job_levels, hr_employment_types, hr_teams, hr_locations,
--         hr_custom_field_definitions, hr_custom_field_values, hr_audit_logs
-- Backfill: hr_people + hr_employments from existing users/organization_members

DO $$ BEGIN
  CREATE TYPE "hr_employment_lifecycle_status" AS ENUM (
    'CANDIDATE', 'PRE_JOINING', 'ONBOARDING', 'ACTIVE', 'PROBATION',
    'CONFIRMED', 'NOTICE', 'EXITED', 'ALUMNI', 'SUSPENDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "hr_worker_type" AS ENUM (
    'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'CONSULTANT',
    'INTERN', 'TEMPORARY', 'AGENCY', 'FREELANCER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "hr_effective_dated_change_type" AS ENUM (
    'department', 'manager', 'location', 'designation', 'job_level',
    'employment_type', 'compensation', 'work_schedule', 'policy_assignment'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "hr_effective_dated_change_status" AS ENUM ('draft', 'approved', 'applied');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "hr_reporting_line_type" AS ENUM ('primary', 'matrix', 'dotted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "hr_custom_field_type" AS ENUM (
    'text', 'number', 'date', 'select', 'multi_select',
    'boolean', 'file', 'employee_ref', 'department_ref', 'currency'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_people" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "work_email" text NOT NULL,
  "personal_email" text,
  "phone" text,
  "date_of_birth" date,
  "gender" text,
  "nationality" text,
  "address" jsonb,
  "emergency_contact" jsonb,
  "avatar_url" text,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_people_org_work_email" ON "hr_people" ("org_id", "work_email") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_people_org" ON "hr_people" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_people_user" ON "hr_people" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_employments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "person_id" integer NOT NULL REFERENCES "hr_people"("id") ON DELETE cascade,
  "employee_number" text NOT NULL,
  "lifecycle_status" "hr_employment_lifecycle_status" NOT NULL DEFAULT 'ACTIVE',
  "worker_type" "hr_worker_type" NOT NULL DEFAULT 'FULL_TIME',
  "department_id" integer REFERENCES "departments"("id") ON DELETE set null,
  "job_role_id" integer,
  "job_level_id" integer,
  "employment_type_id" integer,
  "location_id" integer,
  "designation" text,
  "joining_date" date,
  "probation_end_date" date,
  "confirmation_date" date,
  "notice_start_date" date,
  "expected_last_day" date,
  "last_working_day" date,
  "exit_date" date,
  "exit_reason" text,
  "is_primary" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_employments_org_emp_num" ON "hr_employments" ("org_id", "employee_number") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employments_org" ON "hr_employments" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employments_person" ON "hr_employments" ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employments_org_status" ON "hr_employments" ("org_id", "lifecycle_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employments_dept" ON "hr_employments" ("department_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_employee_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "bio" text,
  "linkedin_url" text,
  "twitter_url" text,
  "github_url" text,
  "website_url" text,
  "skills" text[] DEFAULT '{}',
  "languages" text[] DEFAULT '{}',
  "education" jsonb,
  "certifications" jsonb,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_emp_profiles_employment" ON "hr_employee_profiles" ("employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_emp_profiles_org" ON "hr_employee_profiles" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_employee_sensitive_fields" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "salary_amount_cents" integer,
  "salary_currency" text DEFAULT 'INR',
  "salary_frequency" text DEFAULT 'MONTHLY',
  "bank_details" jsonb,
  "tax_id" text,
  "pan_number" text,
  "national_id" text,
  "passport_number" text,
  "passport_expiry" date,
  "visa_type" text,
  "visa_expiry" date,
  "medical_notes" text,
  "blood_group" text,
  "disciplinary_records" jsonb,
  "grievance_records" jsonb,
  "bgv_status" text,
  "bgv_completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_sensitive_employment" ON "hr_employee_sensitive_fields" ("employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_sensitive_org" ON "hr_employee_sensitive_fields" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_employment_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "from_status" "hr_employment_lifecycle_status" NOT NULL,
  "to_status" "hr_employment_lifecycle_status" NOT NULL,
  "reason" text,
  "notes" text,
  "effective_date" date,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_emp_history_org_employment" ON "hr_employment_history" ("org_id", "employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_emp_history_created_at" ON "hr_employment_history" ("created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_effective_dated_changes" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "change_type" "hr_effective_dated_change_type" NOT NULL,
  "old_value" jsonb,
  "new_value" jsonb,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "status" "hr_effective_dated_change_status" NOT NULL DEFAULT 'draft',
  "approved_by" text REFERENCES "users"("id") ON DELETE set null,
  "approved_at" timestamp,
  "applied_at" timestamp,
  "notes" text,
  "created_by" text NOT NULL REFERENCES "users"("id") ON DELETE restrict,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_eff_changes_org_employment" ON "hr_effective_dated_changes" ("org_id", "employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_eff_changes_org_status" ON "hr_effective_dated_changes" ("org_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_eff_changes_effective_from" ON "hr_effective_dated_changes" ("effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_eff_changes_type" ON "hr_effective_dated_changes" ("change_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_reporting_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "manager_employment_id" integer NOT NULL REFERENCES "hr_employments"("id") ON DELETE cascade,
  "line_type" "hr_reporting_line_type" NOT NULL DEFAULT 'primary',
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_org_emp" ON "hr_reporting_lines" ("org_id", "employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_manager" ON "hr_reporting_lines" ("manager_employment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_reporting_lines_org_type" ON "hr_reporting_lines" ("org_id", "line_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_job_roles" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "code" text,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_job_roles_org_name" ON "hr_job_roles" ("org_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_job_roles_org" ON "hr_job_roles" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_job_levels" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "code" text,
  "grade" text,
  "rank" integer NOT NULL DEFAULT 0,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_job_levels_org_name" ON "hr_job_levels" ("org_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_job_levels_org" ON "hr_job_levels" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_employment_types" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "code" text,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_employment_types_org_name" ON "hr_employment_types" ("org_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_employment_types_org" ON "hr_employment_types" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_teams" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "code" text,
  "description" text,
  "lead_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "parent_team_id" integer,
  "is_active" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_teams_org_name" ON "hr_teams" ("org_id", "name") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_teams_org" ON "hr_teams" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_locations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "code" text,
  "type" text DEFAULT 'OFFICE',
  "address" jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "deleted_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_locations_org_name" ON "hr_locations" ("org_id", "name") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_locations_org" ON "hr_locations" ("org_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_custom_field_definitions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "entity_type" text NOT NULL,
  "name" text NOT NULL,
  "key" text NOT NULL,
  "field_type" "hr_custom_field_type" NOT NULL,
  "options" jsonb,
  "is_sensitive" boolean NOT NULL DEFAULT false,
  "is_required" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_cfd_org_entity_key" ON "hr_custom_field_definitions" ("org_id", "entity_type", "key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_cfd_org_entity" ON "hr_custom_field_definitions" ("org_id", "entity_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_custom_field_values" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "field_definition_id" integer NOT NULL REFERENCES "hr_custom_field_definitions"("id") ON DELETE cascade,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "value" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_cfv_field_entity" ON "hr_custom_field_values" ("field_definition_id", "entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_cfv_org_entity" ON "hr_custom_field_values" ("org_id", "entity_type", "entity_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hr_audit_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "actor_id" text REFERENCES "users"("id") ON DELETE set null,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "action" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_org" ON "hr_audit_logs" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_org_entity" ON "hr_audit_logs" ("org_id", "entity_type", "entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_actor" ON "hr_audit_logs" ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_created_at" ON "hr_audit_logs" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_audit_logs_org_action" ON "hr_audit_logs" ("org_id", "action");--> statement-breakpoint

-- Backfill: create hr_people + hr_employments from existing users via organization_members
-- Guarded with ON CONFLICT DO NOTHING for idempotency

INSERT INTO "hr_people" (
  "org_id", "user_id", "first_name", "last_name", "work_email",
  "phone", "gender", "avatar_url", "created_at", "updated_at"
)
SELECT
  om."org_id",
  u."id",
  COALESCE(u."first_name", split_part(COALESCE(u."name", u."email"), ' ', 1), 'Unknown'),
  COALESCE(u."last_name", NULLIF(split_part(COALESCE(u."name", ''), ' ', 2), ''), ''),
  u."email",
  u."phone",
  u."gender",
  u."image",
  now(),
  now()
FROM "organization_members" om
JOIN "users" u ON u."id" = om."user_id"
WHERE u."is_active" = true
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "hr_employments" (
  "org_id", "person_id", "employee_number", "lifecycle_status", "worker_type",
  "department_id", "designation", "joining_date", "is_primary", "created_at", "updated_at"
)
SELECT
  p."org_id",
  p."id",
  COALESCE(u."employee_id", 'EMP-' || p."id"::text),
  'ACTIVE'::hr_employment_lifecycle_status,
  'FULL_TIME'::hr_worker_type,
  u."department_id",
  u."designation",
  CASE WHEN u."joining_date" IS NOT NULL THEN u."joining_date"::date ELSE NULL END,
  true,
  now(),
  now()
FROM "hr_people" p
JOIN "users" u ON u."id" = p."user_id"
WHERE p."user_id" IS NOT NULL
  AND p."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

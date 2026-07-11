DO $$ BEGIN
  CREATE TYPE "hr_policy_type" AS ENUM (
    'leave','attendance','shift_roster','overtime','comp_off','probation',
    'notice_period','document_requirement','approval','expense','travel',
    'asset','wfh','remote_work','payroll_eligibility'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "hr_policy_status" AS ENUM ('draft','active','archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "hr_policy_scope_type" AS ENUM (
    'organization','country','state','location','department','team',
    'role','job_level','employment_type','employee'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "hr_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "policy_type" "hr_policy_type" NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" "hr_policy_status" DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "parent_policy_id" integer,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "rules" jsonb NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

CREATE TABLE IF NOT EXISTS "hr_policy_scopes" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "policy_id" integer NOT NULL REFERENCES "hr_policies"("id") ON DELETE CASCADE,
  "scope_type" "hr_policy_scope_type" NOT NULL,
  "scope_value" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "hr_policy_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "policy_id" integer NOT NULL REFERENCES "hr_policies"("id") ON DELETE CASCADE,
  "employee_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_policies_org_type_name_version"
  ON "hr_policies" ("org_id", "policy_type", "name", "version");

CREATE INDEX IF NOT EXISTS "idx_hr_policies_org_type_status"
  ON "hr_policies" ("org_id", "policy_type", "status");

CREATE INDEX IF NOT EXISTS "idx_hr_policies_org_status"
  ON "hr_policies" ("org_id", "status");

CREATE INDEX IF NOT EXISTS "idx_hr_policy_scopes_org_policy"
  ON "hr_policy_scopes" ("org_id", "policy_id");

CREATE INDEX IF NOT EXISTS "idx_hr_policy_scopes_org_type_value"
  ON "hr_policy_scopes" ("org_id", "scope_type", "scope_value");

CREATE INDEX IF NOT EXISTS "idx_hr_policy_assignments_org_policy"
  ON "hr_policy_assignments" ("org_id", "policy_id");

CREATE INDEX IF NOT EXISTS "idx_hr_policy_assignments_org_employee"
  ON "hr_policy_assignments" ("org_id", "employee_id");

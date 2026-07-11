DO $$ BEGIN
  CREATE TYPE "hr_workflow_object_type" AS ENUM (
    'leave_request', 'attendance_regularization', 'overtime_request', 'comp_off_request',
    'expense_reimbursement', 'travel_request', 'employee_data_change', 'document_review',
    'asset_request', 'onboarding', 'offboarding', 'probation_confirmation', 'promotion',
    'transfer', 'salary_revision', 'resignation', 'termination', 'grievance_case'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_workflow_status" AS ENUM ('draft', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_workflow_approver_type" AS ENUM (
    'direct_manager', 'managers_manager', 'hr_role', 'finance_role',
    'department_head', 'location_hr', 'named_user', 'dynamic_expression'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_workflow_step_mode" AS ENUM ('serial', 'parallel_all', 'parallel_any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_workflow_instance_status" AS ENUM (
    'pending', 'in_progress', 'approved', 'rejected', 'cancelled', 'reopened'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "hr_workflow_action" AS ENUM (
    'approved', 'rejected', 'reassigned', 'escalated', 'commented', 'cancelled', 'reopened'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "hr_workflow_definitions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "object_type" "hr_workflow_object_type" NOT NULL,
  "name" text NOT NULL,
  "status" "hr_workflow_status" DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_hr_wf_def_org_type_name_version"
  ON "hr_workflow_definitions" ("org_id", "object_type", "name", "version");
CREATE INDEX IF NOT EXISTS "idx_hr_wf_def_org_type_status"
  ON "hr_workflow_definitions" ("org_id", "object_type", "status");

CREATE TABLE IF NOT EXISTS "hr_workflow_steps" (
  "id" serial PRIMARY KEY NOT NULL,
  "definition_id" integer NOT NULL REFERENCES "hr_workflow_definitions"("id") ON DELETE CASCADE,
  "step_order" integer NOT NULL,
  "name" text NOT NULL,
  "approver_type" "hr_workflow_approver_type" NOT NULL,
  "approver_value" text,
  "mode" "hr_workflow_step_mode" DEFAULT 'serial' NOT NULL,
  "sla_hours" integer,
  "escalation_approver_type" "hr_workflow_approver_type",
  "escalation_approver_value" text,
  "condition" jsonb
);

CREATE INDEX IF NOT EXISTS "idx_hr_wf_steps_def_order"
  ON "hr_workflow_steps" ("definition_id", "step_order");

CREATE TABLE IF NOT EXISTS "hr_workflow_instances" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "definition_id" integer NOT NULL REFERENCES "hr_workflow_definitions"("id") ON DELETE RESTRICT,
  "definition_snapshot" jsonb NOT NULL,
  "object_type" "hr_workflow_object_type" NOT NULL,
  "object_id" text NOT NULL,
  "requested_by" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "subject_employee_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "context" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" "hr_workflow_instance_status" DEFAULT 'pending' NOT NULL,
  "current_step_order" integer DEFAULT 1 NOT NULL,
  "due_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_hr_wf_inst_org_obj"
  ON "hr_workflow_instances" ("org_id", "object_type", "object_id");
CREATE INDEX IF NOT EXISTS "idx_hr_wf_inst_org_status"
  ON "hr_workflow_instances" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "idx_hr_wf_inst_org_requester"
  ON "hr_workflow_instances" ("org_id", "requested_by");

CREATE TABLE IF NOT EXISTS "hr_workflow_step_actions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "instance_id" integer NOT NULL REFERENCES "hr_workflow_instances"("id") ON DELETE CASCADE,
  "step_order" integer NOT NULL,
  "approver_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "acted_by_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "action" "hr_workflow_action" NOT NULL,
  "comment" text,
  "attachments" jsonb,
  "acted_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_hr_wf_actions_org_instance"
  ON "hr_workflow_step_actions" ("org_id", "instance_id");

CREATE TABLE IF NOT EXISTS "hr_workflow_delegations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "delegator_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "delegate_user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "object_type" "hr_workflow_object_type",
  "starts_at" timestamp NOT NULL,
  "ends_at" timestamp NOT NULL,
  "reason" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_hr_wf_delegations_org_delegator_active"
  ON "hr_workflow_delegations" ("org_id", "delegator_user_id", "active");

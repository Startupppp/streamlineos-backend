CREATE TABLE IF NOT EXISTS "crm_automation_runs" (
  "id" text NOT NULL PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "rule_id" integer NOT NULL REFERENCES "crm_automation_rules"("id") ON DELETE CASCADE,
  "event_key" text NOT NULL,
  "entity_type" text NOT NULL DEFAULT '',
  "entity_id" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'queued',
  "steps" jsonb,
  "error" text,
  "triggered_by" text NOT NULL DEFAULT 'system',
  "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_crm_automation_runs_org_rule"
  ON "crm_automation_runs"("org_id", "rule_id", "started_at");

CREATE TABLE IF NOT EXISTS "crm_sequences" (
  "id" text NOT NULL PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "entity_type" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "stop_on" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_sequences_org_name"
  ON "crm_sequences"("org_id", "name");

CREATE TABLE IF NOT EXISTS "crm_sequence_steps" (
  "id" text NOT NULL PRIMARY KEY,
  "sequence_id" text NOT NULL REFERENCES "crm_sequences"("id") ON DELETE CASCADE,
  "sort_order" integer NOT NULL,
  "step_type" text NOT NULL,
  "config" jsonb,
  "wait_hours" integer
);

CREATE INDEX IF NOT EXISTS "idx_crm_sequence_steps_seq_sort"
  ON "crm_sequence_steps"("sequence_id", "sort_order");

CREATE TABLE IF NOT EXISTS "crm_sequence_enrollments" (
  "id" text NOT NULL PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sequence_id" text NOT NULL REFERENCES "crm_sequences"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "current_step" integer NOT NULL DEFAULT 0,
  "next_run_at" timestamp,
  "stop_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_crm_seq_enrollment"
  ON "crm_sequence_enrollments"("org_id", "sequence_id", "entity_type", "entity_id");

CREATE INDEX IF NOT EXISTS "idx_crm_seq_enrollment_due"
  ON "crm_sequence_enrollments"("org_id", "status", "next_run_at");

ALTER TABLE "crm_automation_rules"
  ADD COLUMN IF NOT EXISTS "graph" jsonb,
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "is_draft" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "last_error" text,
  ADD COLUMN IF NOT EXISTS "cooldown_minutes" integer NOT NULL DEFAULT 0;

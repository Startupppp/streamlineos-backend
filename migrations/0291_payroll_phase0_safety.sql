-- PayrollOS Phase 0 — safety baseline
-- Idempotency receipts, generation locks, payslip failure fields, adjustment reject

-- Command / job receipts (idempotency + durable history)
DO $$ BEGIN
  CREATE TYPE payroll_command_status AS ENUM ('IN_FLIGHT', 'SUCCEEDED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS payroll_command_receipts (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id integer REFERENCES payroll_runs(id) ON DELETE SET NULL,
  command text NOT NULL,
  idempotency_key text NOT NULL,
  status payroll_command_status NOT NULL DEFAULT 'IN_FLIGHT',
  request_hash text,
  response jsonb,
  error_message text,
  correlation_id text,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_command_receipts_org_cmd_key
  ON payroll_command_receipts (org_id, command, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_payroll_command_receipts_org_run
  ON payroll_command_receipts (org_id, run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_command_receipts_org_status
  ON payroll_command_receipts (org_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_command_receipts_correlation
  ON payroll_command_receipts (correlation_id);

CREATE TABLE IF NOT EXISTS payroll_scheduler_state (
  id serial PRIMARY KEY,
  job_name text NOT NULL,
  last_started_at timestamp,
  last_finished_at timestamp,
  last_success_at timestamp,
  last_error text,
  run_count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payroll_scheduler_state_job
  ON payroll_scheduler_state (job_name);

-- Per-run generation concurrency lock
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS generation_lock_token text,
  ADD COLUMN IF NOT EXISTS generation_locked_at timestamp;

-- Payslip publication failure / retry fields
ALTER TABLE payslip_publications
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamp;

-- Reject-with-reason for payroll input adjustments
DO $$ BEGIN
  ALTER TYPE hr_payroll_adjustment_status ADD VALUE IF NOT EXISTS 'rejected';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE hr_payroll_adjustments
  ADD COLUMN IF NOT EXISTS rejected_by text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamp,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

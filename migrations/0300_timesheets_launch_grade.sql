-- Timesheets launch-grade hardening: duplicate-entry constraint fix, policy fields,
-- effective-dated rates, export idempotency + acknowledgements, audit hash chain,
-- exception management, settings version history.

-- 1) Replace the over-broad ticketless unique index. The old index allowed only ONE
--    ticketless entry per user per day org-wide (breaking multi-project day logging)
--    and counted voided entries. New indexes: one entry per (user, day, project) and
--    one truly-blank entry per (user, day), both ignoring voided rows.
DROP INDEX IF EXISTS "uniq_timesheets_work_log";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_day_project"
  ON "timesheets" ("org_id", "user_id", "date", "project_id")
  WHERE "ticket_id" IS NULL AND "project_id" IS NOT NULL AND "voided_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_day_blank"
  ON "timesheets" ("org_id", "user_id", "date")
  WHERE "ticket_id" IS NULL AND "project_id" IS NULL AND "voided_at" IS NULL;

-- 2) Policy fields on settings
ALTER TABLE "timesheet_settings" ADD COLUMN IF NOT EXISTS "allow_future_entries" boolean NOT NULL DEFAULT false;
ALTER TABLE "timesheet_settings" ADD COLUMN IF NOT EXISTS "expected_daily_hours" numeric(4,2);
ALTER TABLE "timesheet_settings" ADD COLUMN IF NOT EXISTS "expected_weekly_hours" numeric(5,2);
ALTER TABLE "timesheet_settings" ADD COLUMN IF NOT EXISTS "submission_grace_days" integer;

-- 3) Effective-dated rates
ALTER TABLE "timesheet_rates" ADD COLUMN IF NOT EXISTS "effective_from" date;
ALTER TABLE "timesheet_rates" ADD COLUMN IF NOT EXISTS "effective_to" date;

-- 4) Export idempotency + destination acknowledgements
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "ack_status" text;
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "ack_note" text;
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "ack_at" timestamp;
ALTER TABLE "timesheet_exports" ADD COLUMN IF NOT EXISTS "ack_by" text REFERENCES "users"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheet_exports_idem"
  ON "timesheet_exports" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- 5) Tamper-evident audit hash chain
ALTER TABLE "timesheet_audit_events" ADD COLUMN IF NOT EXISTS "prev_hash" text;
ALTER TABLE "timesheet_audit_events" ADD COLUMN IF NOT EXISTS "row_hash" text;

-- 6) Exception management
CREATE TABLE IF NOT EXISTS "timesheet_exceptions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_id" integer REFERENCES "timesheet_periods"("id") ON DELETE CASCADE,
  "entry_id" integer REFERENCES "timesheets"("id") ON DELETE CASCADE,
  "rule" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'WARNING',
  "status" text NOT NULL DEFAULT 'OPEN',
  "message" text NOT NULL,
  "details" jsonb,
  "owner_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "due_date" date,
  "resolution_reason" text,
  "resolved_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_ts_exceptions_org_status" ON "timesheet_exceptions" ("org_id", "status", "severity");
CREATE INDEX IF NOT EXISTS "idx_ts_exceptions_user" ON "timesheet_exceptions" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_ts_exceptions_period" ON "timesheet_exceptions" ("period_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ts_exceptions_open_rule"
  ON "timesheet_exceptions" ("org_id", "user_id", "rule", COALESCE("period_id", -1), COALESCE("entry_id", -1))
  WHERE "status" = 'OPEN';

-- 7) Versioned settings history (append-only)
CREATE TABLE IF NOT EXISTS "timesheet_settings_history" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "settings" jsonb NOT NULL,
  "changed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "change_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_ts_settings_history_version"
  ON "timesheet_settings_history" ("org_id", "version");

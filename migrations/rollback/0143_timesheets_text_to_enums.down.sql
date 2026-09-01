-- Rollback for 0143_timesheets_text_to_enums
-- Reverses: 17 CREATE TYPE + 18 column conversions from text → enum
--
-- Strategy: cast each enum column back to text using ::text, restore the
-- original text DEFAULT, then DROP each enum type. Types can only be
-- dropped after all columns that reference them are already converted.

SET lock_timeout = '5s';
SET statement_timeout = 0;

-- ── timesheets ──────────────────────────────────────────────────────────────

ALTER TABLE "timesheets" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "status"
  TYPE text USING "status"::text;
ALTER TABLE "timesheets" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "timesheets" ALTER COLUMN "payroll_status" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "payroll_status"
  TYPE text USING "payroll_status"::text;
ALTER TABLE "timesheets" ALTER COLUMN "payroll_status" SET DEFAULT 'UNPROCESSED';

ALTER TABLE "timesheets" ALTER COLUMN "billing_type" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "billing_type"
  TYPE text USING "billing_type"::text;
ALTER TABLE "timesheets" ALTER COLUMN "billing_type" SET DEFAULT 'BILLABLE';

ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status"
  TYPE text USING "invoicing_status"::text;
ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status" SET DEFAULT 'UNINVOICED';

ALTER TABLE "timesheets" ALTER COLUMN "rate_source" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "rate_source"
  TYPE text USING "rate_source"::text;
-- rate_source had no explicit DEFAULT before the migration (dropped before convert)

ALTER TABLE "timesheets" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "timesheets" ALTER COLUMN "source"
  TYPE text USING "source"::text;
ALTER TABLE "timesheets" ALTER COLUMN "source" SET DEFAULT 'MANUAL';

-- ── timesheet_periods ────────────────────────────────────────────────────────

ALTER TABLE "timesheet_periods" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "timesheet_periods" ALTER COLUMN "status"
  TYPE text USING "status"::text;
ALTER TABLE "timesheet_periods" ALTER COLUMN "status" SET DEFAULT 'OPEN';

-- ── timer_sessions ───────────────────────────────────────────────────────────

ALTER TABLE "timer_sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "timer_sessions" ALTER COLUMN "status"
  TYPE text USING "status"::text;
ALTER TABLE "timer_sessions" ALTER COLUMN "status" SET DEFAULT 'RUNNING';

ALTER TABLE "timer_sessions" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "timer_sessions" ALTER COLUMN "source"
  TYPE text USING "source"::text;
ALTER TABLE "timer_sessions" ALTER COLUMN "source" SET DEFAULT 'WEB';

-- ── timesheet_budgets ────────────────────────────────────────────────────────
-- Migration 0616 added a partial index on timesheet_budgets.status whose
-- predicate stores a timesheet_budget_status enum literal. PostgreSQL cannot
-- rewrite that predicate when the column type changes back to text because
-- there is no `text = timesheet_budget_status` operator. Drop the index first
-- so the type conversion can proceed; it is invalid in the pre-0143 state anyway.
DROP INDEX IF EXISTS "uniq_timesheet_budgets_active_project";

ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type" DROP DEFAULT;
ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type"
  TYPE text USING "budget_type"::text;
ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type" SET DEFAULT 'HOURS';

ALTER TABLE "timesheet_budgets" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "timesheet_budgets" ALTER COLUMN "status"
  TYPE text USING "status"::text;
ALTER TABLE "timesheet_budgets" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- ── timesheet_exports ────────────────────────────────────────────────────────

ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type" DROP DEFAULT;
ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type"
  TYPE text USING "export_type"::text;
ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type" SET DEFAULT 'PAYROLL';

ALTER TABLE "timesheet_exports" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "timesheet_exports" ALTER COLUMN "status"
  TYPE text USING "status"::text;
ALTER TABLE "timesheet_exports" ALTER COLUMN "status" SET DEFAULT 'COMPLETED';

ALTER TABLE "timesheet_exports" ALTER COLUMN "format" DROP DEFAULT;
ALTER TABLE "timesheet_exports" ALTER COLUMN "format"
  TYPE text USING "format"::text;
-- format had no explicit DEFAULT before the migration

-- ── timesheet_settings ───────────────────────────────────────────────────────

ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule" DROP DEFAULT;
ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule"
  TYPE text USING "rounding_rule"::text;
ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule" SET DEFAULT 'NONE';

ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode" DROP DEFAULT;
ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode"
  TYPE text USING "approval_mode"::text;
ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode" SET DEFAULT 'MANAGER';

ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period" DROP DEFAULT;
ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period"
  TYPE text USING "pay_period"::text;
ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period" SET DEFAULT 'MONTHLY';

-- ── timesheet_rates ──────────────────────────────────────────────────────────

ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type" DROP DEFAULT;
ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type"
  TYPE text USING "billing_type"::text;
ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type" SET DEFAULT 'BILLABLE';

-- ── drop enum types (only safe after all column conversions above) ────────────

DROP TYPE IF EXISTS "timesheet_entry_status";
DROP TYPE IF EXISTS "timesheet_payroll_status";
DROP TYPE IF EXISTS "timesheet_billing_type";
DROP TYPE IF EXISTS "timesheet_invoicing_status";
DROP TYPE IF EXISTS "timesheet_rate_source";
DROP TYPE IF EXISTS "timesheet_entry_source";
DROP TYPE IF EXISTS "timesheet_period_status";
DROP TYPE IF EXISTS "timer_session_status";
DROP TYPE IF EXISTS "timer_session_source";
DROP TYPE IF EXISTS "timesheet_budget_type";
DROP TYPE IF EXISTS "timesheet_budget_status";
DROP TYPE IF EXISTS "timesheet_export_type";
DROP TYPE IF EXISTS "timesheet_export_status";
DROP TYPE IF EXISTS "timesheet_export_format";
DROP TYPE IF EXISTS "timesheet_rounding_rule";
DROP TYPE IF EXISTS "timesheet_approval_mode";
DROP TYPE IF EXISTS "timesheet_pay_period";

-- Payroll domain: enums, core tables, and new supplementary tables.
-- Covers hr/payroll-policies, hr/payroll-runs, hr/payroll-payout, hr/payroll-workforce
-- plus the new payroll/ schema additions (templates, inputs, run-events, payslip-publications, tax-windows).

--> statement-breakpoint
CREATE TYPE "payroll_run_status" AS ENUM (
  'PREPARING','DRAFT','PREVIEW_READY','EXCEPTIONS_FOUND','PENDING_APPROVAL',
  'APPROVED','LOCKED','PAID','PAYSLIPS_PUBLISHED','CLOSED','REOPENED'
);
--> statement-breakpoint
CREATE TYPE "payroll_worker_type" AS ENUM (
  'EMPLOYEE','CONTRACTOR','CONSULTANT','INTERN','EOR'
);
--> statement-breakpoint
CREATE TYPE "salary_component_type" AS ENUM (
  'EARNING','DEDUCTION','EMPLOYER_CONTRIBUTION','REIMBURSEMENT','TAX','ADJUSTMENT'
);
--> statement-breakpoint
CREATE TYPE "salary_component_calc_method" AS ENUM (
  'FIXED','PERCENT_OF_BASIC','PERCENT_OF_GROSS','FORMULA',
  'ATTENDANCE_BASED','TIMESHEET_BASED','MANUAL'
);
--> statement-breakpoint
CREATE TYPE "payroll_exception_severity" AS ENUM ('BLOCKER','WARNING','INFO');
--> statement-breakpoint
CREATE TYPE "payroll_exception_status" AS ENUM ('OPEN','RESOLVED','OVERRIDDEN');
--> statement-breakpoint
CREATE TYPE "payroll_approval_status" AS ENUM ('PENDING','APPROVED','REJECTED');
--> statement-breakpoint
CREATE TYPE "payroll_bank_batch_status" AS ENUM (
  'DRAFT','GENERATED','SENT','PARTIALLY_PAID','PAID','FAILED'
);
--> statement-breakpoint
CREATE TYPE "payroll_bank_item_status" AS ENUM ('PENDING','SENT','PAID','FAILED','HELD');
--> statement-breakpoint
CREATE TYPE "payroll_policy_status" AS ENUM ('DRAFT','ACTIVE','SUPERSEDED','ARCHIVED');
--> statement-breakpoint
CREATE TYPE "salary_profile_status" AS ENUM ('UPCOMING','ACTIVE','SUPERSEDED');
--> statement-breakpoint
CREATE TYPE "pay_frequency" AS ENUM ('MONTHLY','SEMI_MONTHLY','BI_WEEKLY','WEEKLY');
--> statement-breakpoint
CREATE TYPE "tax_regime_type" AS ENUM ('OLD','NEW');
--> statement-breakpoint
CREATE TYPE "payslip_layout" AS ENUM ('CLASSIC','MODERN','COMPLIANCE');
--> statement-breakpoint
CREATE TYPE "payslip_publish_channel" AS ENUM ('PORTAL','EMAIL');
--> statement-breakpoint
CREATE TYPE "payroll_calendar_event_type" AS ENUM (
  'ATTENDANCE_CUTOFF','REIMBURSEMENT_CUTOFF','DECLARATION_CUTOFF',
  'PREVIEW_DUE','APPROVAL_DEADLINE','PAY_DATE','PUBLISH_DATE'
);
--> statement-breakpoint
CREATE TYPE "payroll_loan_adjustment_type" AS ENUM (
  'SKIP_EMI','EXTRA_RECOVERY','FORECLOSURE','MANUAL_ADJUST'
);
--> statement-breakpoint
CREATE TYPE "payroll_template_category" AS ENUM (
  'INDIAN_STANDARD','INDIAN_STARTUP','CONTRACTOR','SALES_INCENTIVE',
  'GLOBAL_REMOTE','HOURLY','MANUFACTURING','STAFFING','EXECUTIVE','CUSTOM'
);
--> statement-breakpoint
CREATE TYPE "payroll_input_source" AS ENUM (
  'ATTENDANCE','LEAVE','TIMESHEET','UPLOAD','MANUAL'
);
--> statement-breakpoint
CREATE TYPE "payroll_run_event_type" AS ENUM (
  'GENERATED','RECALCULATED','APPROVAL_SUBMITTED','APPROVED','REJECTED',
  'LOCKED','REOPENED','MARKED_PAID','PAYSLIPS_PUBLISHED',
  'BANK_BATCH_GENERATED','EXCEPTION_OVERRIDDEN','INPUT_OVERRIDDEN'
);
--> statement-breakpoint
CREATE TYPE "payslip_publication_status" AS ENUM ('PENDING','PUBLISHED','FAILED');
--> statement-breakpoint
CREATE TYPE "payroll_tax_window_status" AS ENUM ('DRAFT','OPEN','CLOSED','LOCKED');

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_policies" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "status" "payroll_policy_status" NOT NULL DEFAULT 'DRAFT',
  "country" text NOT NULL,
  "state" text,
  "legal_entity_name" text,
  "currency" text NOT NULL DEFAULT 'INR',
  "pay_frequency" "pay_frequency" NOT NULL DEFAULT 'MONTHLY',
  "pay_day" integer NOT NULL DEFAULT 28,
  "start_month" text NOT NULL,
  "active_version_id" integer,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_policies_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_policies_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_policies_org" ON "payroll_policies" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_policies_org_status" ON "payroll_policies" ("org_id","status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_policy_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "policy_id" integer NOT NULL,
  "version" integer NOT NULL,
  "template_key" text,
  "toggles" jsonb NOT NULL,
  "config" jsonb NOT NULL,
  "status" "payroll_policy_status" NOT NULL DEFAULT 'DRAFT',
  "effective_from" date NOT NULL,
  "reason" text,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_policy_versions_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_policy_versions_policy_id_fk"
    FOREIGN KEY ("policy_id") REFERENCES "payroll_policies"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_policy_versions_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_policy_versions_policy_version"
  ON "payroll_policy_versions" ("policy_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_policy_versions_org_policy"
  ON "payroll_policy_versions" ("org_id","policy_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_custom_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "base_template_key" text NOT NULL,
  "description" text,
  "config" jsonb NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_custom_templates_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_custom_templates_org" ON "payroll_custom_templates" ("org_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_template_activations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "policy_version_id" integer NOT NULL,
  "template_key" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "activated_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_template_activations_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_template_activations_policy_version_id_fk"
    FOREIGN KEY ("policy_version_id") REFERENCES "payroll_policy_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_template_activations_activated_by_fk"
    FOREIGN KEY ("activated_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_template_activations_org"
  ON "payroll_template_activations" ("org_id","policy_version_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_calendar_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "policy_id" integer,
  "month" text,
  "type" "payroll_calendar_event_type" NOT NULL,
  "date" date NOT NULL,
  "title" text NOT NULL,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_calendar_events_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_calendar_events_policy_id_fk"
    FOREIGN KEY ("policy_id") REFERENCES "payroll_policies"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_calendar_events_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_calendar_events_org_date"
  ON "payroll_calendar_events" ("org_id","date");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_accounting_mappings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "component_id" integer,
  "category" text,
  "ledger_name" text NOT NULL,
  "cost_center_source" text,
  "notes" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_accounting_mappings_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_accounting_mappings_org"
  ON "payroll_accounting_mappings" ("org_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "salary_components" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" "salary_component_type" NOT NULL,
  "calc_method" "salary_component_calc_method" NOT NULL,
  "amount" decimal(15,2),
  "percent" decimal(7,4),
  "formula" text,
  "taxable" boolean NOT NULL DEFAULT false,
  "show_on_payslip" boolean NOT NULL DEFAULT true,
  "include_in_ctc" boolean NOT NULL DEFAULT true,
  "is_statutory" boolean NOT NULL DEFAULT false,
  "statutory_key" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "effective_from" date,
  "effective_to" date,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "salary_components_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_salary_components_org_code"
  ON "salary_components" ("org_id","code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_salary_components_org_active"
  ON "salary_components" ("org_id","is_active");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_salary_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "worker_type" "payroll_worker_type" NOT NULL DEFAULT 'EMPLOYEE',
  "pay_frequency" "pay_frequency" NOT NULL DEFAULT 'MONTHLY',
  "currency" text NOT NULL DEFAULT 'INR',
  "payout_currency" text,
  "fx_source" text,
  "tax_regime" "tax_regime_type",
  "cost_center" text,
  "annual_ctc" decimal(15,2) NOT NULL,
  "status" "salary_profile_status" NOT NULL DEFAULT 'ACTIVE',
  "effective_from" date NOT NULL,
  "effective_to" date,
  "policy_version_id" integer,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "employee_salary_profiles_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "employee_salary_profiles_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "employee_salary_profiles_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_salary_profiles_org_user_effective"
  ON "employee_salary_profiles" ("org_id","user_id","effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_salary_profiles_org_status"
  ON "employee_salary_profiles" ("org_id","status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_salary_profile_components" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "profile_id" integer NOT NULL,
  "component_id" integer NOT NULL,
  "calc_method_override" "salary_component_calc_method",
  "amount" decimal(15,2),
  "percent" decimal(7,4),
  "formula_override" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "esp_components_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "esp_components_profile_id_fk"
    FOREIGN KEY ("profile_id") REFERENCES "employee_salary_profiles"("id") ON DELETE CASCADE,
  CONSTRAINT "esp_components_component_id_fk"
    FOREIGN KEY ("component_id") REFERENCES "salary_components"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_salary_profile_components_profile"
  ON "employee_salary_profile_components" ("profile_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_salary_profile_components_org"
  ON "employee_salary_profile_components" ("org_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_loan_adjustments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "loan_id" integer NOT NULL,
  "run_id" integer,
  "type" "payroll_loan_adjustment_type" NOT NULL,
  "amount" decimal(15,2),
  "reason" text NOT NULL,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_loan_adjustments_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_loan_adjustments_loan_id_fk"
    FOREIGN KEY ("loan_id") REFERENCES "salary_loans"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_loan_adjustments_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_loan_adjustments_org_loan"
  ON "payroll_loan_adjustments" ("org_id","loan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_loan_adjustments_run"
  ON "payroll_loan_adjustments" ("run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "policy_version_id" integer,
  "month" text NOT NULL,
  "status" "payroll_run_status" NOT NULL DEFAULT 'PREPARING',
  "pay_date" date,
  "gross_total" decimal(15,2) NOT NULL DEFAULT '0',
  "deduction_total" decimal(15,2) NOT NULL DEFAULT '0',
  "employer_cost_total" decimal(15,2) NOT NULL DEFAULT '0',
  "net_total" decimal(15,2) NOT NULL DEFAULT '0',
  "employee_count" integer NOT NULL DEFAULT 0,
  "exception_count" integer NOT NULL DEFAULT 0,
  "locked_at" timestamp,
  "locked_by" text,
  "approved_at" timestamp,
  "approved_by" text,
  "paid_at" timestamp,
  "paid_by" text,
  "published_at" timestamp,
  "published_by" text,
  "closed_at" timestamp,
  "reopened_at" timestamp,
  "reopened_by" text,
  "reopen_reason" text,
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_runs_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_runs_policy_version_id_fk"
    FOREIGN KEY ("policy_version_id") REFERENCES "payroll_policy_versions"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_locked_by_fk"
    FOREIGN KEY ("locked_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_approved_by_fk"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_paid_by_fk"
    FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_published_by_fk"
    FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_reopened_by_fk"
    FOREIGN KEY ("reopened_by") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_runs_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_runs_org_month" ON "payroll_runs" ("org_id","month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_runs_org_status" ON "payroll_runs" ("org_id","status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_run_employees" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "profile_id" integer,
  "worker_type" "payroll_worker_type" NOT NULL DEFAULT 'EMPLOYEE',
  "currency" text NOT NULL DEFAULT 'INR',
  "payout_currency" text,
  "fx_rate" decimal(12,6),
  "scheduled_days" decimal(5,1) NOT NULL DEFAULT '0',
  "paid_days" decimal(5,1) NOT NULL DEFAULT '0',
  "lop_days" decimal(5,1) NOT NULL DEFAULT '0',
  "overtime_hours" decimal(6,2) NOT NULL DEFAULT '0',
  "gross" decimal(15,2) NOT NULL DEFAULT '0',
  "total_deductions" decimal(15,2) NOT NULL DEFAULT '0',
  "employer_contributions" decimal(15,2) NOT NULL DEFAULT '0',
  "net" decimal(15,2) NOT NULL DEFAULT '0',
  "net_payout_currency" decimal(15,2),
  "status" text NOT NULL DEFAULT 'PENDING',
  "hold_reason" text,
  "inputs_snapshot" jsonb,
  "calculation_snapshot" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_run_employees_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_run_employees_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_run_employees_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_run_employees_run_user"
  ON "payroll_run_employees" ("run_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_run_employees_org_run"
  ON "payroll_run_employees" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_line_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "run_employee_id" integer NOT NULL,
  "component_id" integer,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category" "salary_component_type" NOT NULL,
  "amount" decimal(15,2) NOT NULL,
  "calc_method" "salary_component_calc_method" NOT NULL,
  "calc_explain" jsonb NOT NULL,
  "taxable" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_line_items_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_line_items_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_line_items_run_employee_id_fk"
    FOREIGN KEY ("run_employee_id") REFERENCES "payroll_run_employees"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_line_items_run_employee"
  ON "payroll_line_items" ("run_employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_line_items_org_run"
  ON "payroll_line_items" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_exceptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "run_employee_id" integer,
  "user_id" text,
  "code" text NOT NULL,
  "severity" "payroll_exception_severity" NOT NULL,
  "status" "payroll_exception_status" NOT NULL DEFAULT 'OPEN',
  "message" text NOT NULL,
  "metadata" jsonb,
  "resolved_by" text,
  "resolved_at" timestamp,
  "override_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_exceptions_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_exceptions_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_exceptions_run_employee_id_fk"
    FOREIGN KEY ("run_employee_id") REFERENCES "payroll_run_employees"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_exceptions_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "payroll_exceptions_resolved_by_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_exceptions_org_run_status"
  ON "payroll_exceptions" ("org_id","run_id","status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_approvals" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "stage" integer NOT NULL,
  "stage_name" text NOT NULL,
  "required_permission" text NOT NULL,
  "status" "payroll_approval_status" NOT NULL DEFAULT 'PENDING',
  "acted_by" text,
  "acted_at" timestamp,
  "comment" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_approvals_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_approvals_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_approvals_acted_by_fk"
    FOREIGN KEY ("acted_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_approvals_run_stage"
  ON "payroll_approvals" ("run_id","stage");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_approvals_org_run"
  ON "payroll_approvals" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_lock_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "action" text NOT NULL,
  "reason" text,
  "actor_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_lock_events_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_lock_events_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_lock_events_actor_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_lock_events_org_run"
  ON "payroll_lock_events" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payslip_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "layout" "payslip_layout" NOT NULL,
  "config" jsonb NOT NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payslip_templates_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_templates_org" ON "payslip_templates" ("org_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payslip_publish_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "run_employee_id" integer,
  "channel" "payslip_publish_channel" NOT NULL,
  "published_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payslip_publish_events_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payslip_publish_events_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payslip_publish_events_run_employee_id_fk"
    FOREIGN KEY ("run_employee_id") REFERENCES "payroll_run_employees"("id") ON DELETE CASCADE,
  CONSTRAINT "payslip_publish_events_published_by_fk"
    FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_publish_events_org_run"
  ON "payslip_publish_events" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_bank_batches" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "batch_number" text NOT NULL,
  "status" "payroll_bank_batch_status" NOT NULL DEFAULT 'DRAFT',
  "format" text NOT NULL,
  "total_amount" decimal(15,2) NOT NULL,
  "item_count" integer NOT NULL DEFAULT 0,
  "idempotency_key" text,
  "generated_by" text,
  "generated_at" timestamp NOT NULL DEFAULT now(),
  "sent_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_bank_batches_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_bank_batches_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_bank_batches_generated_by_fk"
    FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_bank_batches_org_number"
  ON "payroll_bank_batches" ("org_id","batch_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_bank_batches_idempotency_key"
  ON "payroll_bank_batches" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_bank_batches_org_run"
  ON "payroll_bank_batches" ("org_id","run_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_bank_batch_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "batch_id" integer NOT NULL,
  "run_employee_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "amount" decimal(15,2) NOT NULL,
  "account_masked" text NOT NULL,
  "ifsc" text,
  "status" "payroll_bank_item_status" NOT NULL DEFAULT 'PENDING',
  "failure_reason" text,
  "transaction_ref" text,
  "paid_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_bank_batch_items_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_bank_batch_items_batch_id_fk"
    FOREIGN KEY ("batch_id") REFERENCES "payroll_bank_batches"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_bank_batch_items_run_employee_id_fk"
    FOREIGN KEY ("run_employee_id") REFERENCES "payroll_run_employees"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_bank_batch_items_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_bank_batch_items_batch_status"
  ON "payroll_bank_batch_items" ("batch_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_bank_batch_items_org"
  ON "payroll_bank_batch_items" ("org_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text,
  "key" text,
  "name" text NOT NULL,
  "description" text,
  "best_for" text,
  "complexity" text,
  "badge" text,
  "category" "payroll_template_category" NOT NULL DEFAULT 'CUSTOM',
  "default_toggles" jsonb NOT NULL,
  "default_components" jsonb NOT NULL,
  "is_system" boolean NOT NULL DEFAULT false,
  "is_recommended" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_templates_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_templates_org" ON "payroll_templates" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_templates_system" ON "payroll_templates" ("is_system");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_templates_category" ON "payroll_templates" ("category");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_inputs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "source" "payroll_input_source" NOT NULL,
  "scheduled_days" decimal(6,2) NOT NULL DEFAULT '0',
  "paid_days" decimal(6,2) NOT NULL DEFAULT '0',
  "lop_days" decimal(6,2) NOT NULL DEFAULT '0',
  "half_days" decimal(6,2) NOT NULL DEFAULT '0',
  "overtime_hours" decimal(8,2) NOT NULL DEFAULT '0',
  "shift_allowance_units" decimal(8,2) NOT NULL DEFAULT '0',
  "holiday_work_days" decimal(6,2) NOT NULL DEFAULT '0',
  "billable_hours" decimal(8,2) NOT NULL DEFAULT '0',
  "is_override" boolean NOT NULL DEFAULT false,
  "override_reason" text,
  "overridden_by" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_inputs_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_inputs_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_inputs_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "payroll_inputs_overridden_by_fk"
    FOREIGN KEY ("overridden_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_inputs_run_user"
  ON "payroll_inputs" ("run_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_inputs_run" ON "payroll_inputs" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_inputs_org_user" ON "payroll_inputs" ("org_id","user_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_run_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "type" "payroll_run_event_type" NOT NULL,
  "actor_id" text,
  "reason" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_run_events_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_run_events_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "payroll_run_events_actor_id_fk"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_run_events_run" ON "payroll_run_events" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_run_events_org_type"
  ON "payroll_run_events" ("org_id","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_run_events_org_created"
  ON "payroll_run_events" ("org_id","created_at");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payslip_publications" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "run_id" integer NOT NULL,
  "run_employee_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "payslip_template_id" integer,
  "pdf_url" text,
  "published_at" timestamp,
  "published_by" text,
  "channel" "payslip_publish_channel" NOT NULL DEFAULT 'PORTAL',
  "status" "payslip_publication_status" NOT NULL DEFAULT 'PENDING',
  "snapshot_hash" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payslip_publications_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "payslip_publications_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT,
  CONSTRAINT "payslip_publications_run_employee_id_fk"
    FOREIGN KEY ("run_employee_id") REFERENCES "payroll_run_employees"("id") ON DELETE RESTRICT,
  CONSTRAINT "payslip_publications_user_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "payslip_publications_template_id_fk"
    FOREIGN KEY ("payslip_template_id") REFERENCES "payslip_templates"("id") ON DELETE SET NULL,
  CONSTRAINT "payslip_publications_published_by_fk"
    FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payslip_publications_run_employee"
  ON "payslip_publications" ("run_employee_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_publications_run" ON "payslip_publications" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_publications_user" ON "payslip_publications" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_publications_org_status"
  ON "payslip_publications" ("org_id","status");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payroll_tax_windows" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "financial_year" text NOT NULL,
  "opens_at" timestamp NOT NULL,
  "closes_at" timestamp NOT NULL,
  "proof_deadline" timestamp,
  "lock_date" date,
  "status" "payroll_tax_window_status" NOT NULL DEFAULT 'DRAFT',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_tax_windows_org_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payroll_tax_windows_org_year"
  ON "payroll_tax_windows" ("org_id","financial_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_tax_windows_org" ON "payroll_tax_windows" ("org_id");

SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_entry_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_payroll_status" AS ENUM ('UNPROCESSED', 'EXPORTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_billing_type" AS ENUM ('BILLABLE', 'NON_BILLABLE', 'FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_invoicing_status" AS ENUM ('UNINVOICED', 'INVOICE_DRAFTED', 'INVOICED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_rate_source" AS ENUM ('RATE_CARD', 'PROJECT_MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_entry_source" AS ENUM ('MANUAL', 'TIMER', 'API', 'IMPORT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_period_status" AS ENUM ('OPEN', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timer_session_status" AS ENUM ('RUNNING', 'PAUSED', 'STOPPED', 'CONVERTED', 'DISCARDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timer_session_source" AS ENUM ('WEB', 'MOBILE', 'DESKTOP', 'API');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_budget_type" AS ENUM ('HOURS', 'AMOUNT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_budget_status" AS ENUM ('ACTIVE', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_export_type" AS ENUM ('PAYROLL', 'BILLING', 'INVOICE_DRAFT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_export_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_export_format" AS ENUM ('CSV', 'XLSX', 'JSON', 'PDF');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_rounding_rule" AS ENUM ('NONE', 'NEAREST_5', 'NEAREST_6', 'NEAREST_10', 'NEAREST_15', 'ROUND_UP', 'ROUND_DOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_approval_mode" AS ENUM ('MANAGER', 'AUTO', 'MULTI_LEVEL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "timesheet_pay_period" AS ENUM ('WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "status" TYPE "timesheet_entry_status" USING "status"::"timesheet_entry_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"timesheet_entry_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "payroll_status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "payroll_status" TYPE "timesheet_payroll_status" USING "payroll_status"::"timesheet_payroll_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "payroll_status" SET DEFAULT 'UNPROCESSED'::"timesheet_payroll_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "billing_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "billing_type" TYPE "timesheet_billing_type" USING "billing_type"::"timesheet_billing_type";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "billing_type" SET DEFAULT 'BILLABLE'::"timesheet_billing_type";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status" TYPE "timesheet_invoicing_status" USING "invoicing_status"::"timesheet_invoicing_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "invoicing_status" SET DEFAULT 'UNINVOICED'::"timesheet_invoicing_status";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "rate_source" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "rate_source" TYPE "timesheet_rate_source" USING "rate_source"::"timesheet_rate_source";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "source" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "source" TYPE "timesheet_entry_source" USING "source"::"timesheet_entry_source";
--> statement-breakpoint
ALTER TABLE "timesheets" ALTER COLUMN "source" SET DEFAULT 'MANUAL'::"timesheet_entry_source";
--> statement-breakpoint
ALTER TABLE "timesheet_periods" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_periods" ALTER COLUMN "status" TYPE "timesheet_period_status" USING "status"::"timesheet_period_status";
--> statement-breakpoint
ALTER TABLE "timesheet_periods" ALTER COLUMN "status" SET DEFAULT 'OPEN'::"timesheet_period_status";
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "status" TYPE "timer_session_status" USING "status"::"timer_session_status";
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "status" SET DEFAULT 'RUNNING'::"timer_session_status";
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "source" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "source" TYPE "timer_session_source" USING "source"::"timer_session_source";
--> statement-breakpoint
ALTER TABLE "timer_sessions" ALTER COLUMN "source" SET DEFAULT 'WEB'::"timer_session_source";
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type" TYPE "timesheet_budget_type" USING "budget_type"::"timesheet_budget_type";
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "budget_type" SET DEFAULT 'HOURS'::"timesheet_budget_type";
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "status" TYPE "timesheet_budget_status" USING "status"::"timesheet_budget_status";
--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"timesheet_budget_status";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type" TYPE "timesheet_export_type" USING "export_type"::"timesheet_export_type";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "export_type" SET DEFAULT 'PAYROLL'::"timesheet_export_type";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "status" TYPE "timesheet_export_status" USING "status"::"timesheet_export_status";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "status" SET DEFAULT 'COMPLETED'::"timesheet_export_status";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "format" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ALTER COLUMN "format" TYPE "timesheet_export_format" USING "format"::"timesheet_export_format";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule" TYPE "timesheet_rounding_rule" USING "rounding_rule"::"timesheet_rounding_rule";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "rounding_rule" SET DEFAULT 'NONE'::"timesheet_rounding_rule";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode" TYPE "timesheet_approval_mode" USING "approval_mode"::"timesheet_approval_mode";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "approval_mode" SET DEFAULT 'MANAGER'::"timesheet_approval_mode";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period" TYPE "timesheet_pay_period" USING "pay_period"::"timesheet_pay_period";
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ALTER COLUMN "pay_period" SET DEFAULT 'MONTHLY'::"timesheet_pay_period";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type" TYPE "timesheet_billing_type" USING "billing_type"::"timesheet_billing_type";
--> statement-breakpoint
ALTER TABLE "timesheet_rates" ALTER COLUMN "billing_type" SET DEFAULT 'BILLABLE'::"timesheet_billing_type";

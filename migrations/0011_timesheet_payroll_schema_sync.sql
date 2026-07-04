CREATE TYPE "public"."payroll_run_status" AS ENUM('PREPARING', 'DRAFT', 'PREVIEW_READY', 'EXCEPTIONS_FOUND', 'PENDING_APPROVAL', 'APPROVED', 'LOCKED', 'PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED', 'REOPENED');
--> statement-breakpoint
CREATE TYPE "public"."payroll_worker_type" AS ENUM('EMPLOYEE', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'EOR');
--> statement-breakpoint
CREATE TYPE "public"."salary_component_type" AS ENUM('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT', 'TAX', 'ADJUSTMENT');
--> statement-breakpoint
CREATE TYPE "public"."salary_component_calc_method" AS ENUM('FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'FORMULA', 'ATTENDANCE_BASED', 'TIMESHEET_BASED', 'MANUAL');
--> statement-breakpoint
CREATE TYPE "public"."payroll_exception_severity" AS ENUM('BLOCKER', 'WARNING', 'INFO');
--> statement-breakpoint
CREATE TYPE "public"."payroll_exception_status" AS ENUM('OPEN', 'RESOLVED', 'OVERRIDDEN');
--> statement-breakpoint
CREATE TYPE "public"."payroll_approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');
--> statement-breakpoint
CREATE TYPE "public"."payroll_bank_batch_status" AS ENUM('DRAFT', 'GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'FAILED');
--> statement-breakpoint
CREATE TYPE "public"."payroll_bank_item_status" AS ENUM('PENDING', 'SENT', 'PAID', 'FAILED', 'HELD');
--> statement-breakpoint
CREATE TYPE "public"."payroll_policy_status" AS ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');
--> statement-breakpoint
CREATE TYPE "public"."salary_profile_status" AS ENUM('UPCOMING', 'ACTIVE', 'SUPERSEDED');
--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('MONTHLY', 'SEMI_MONTHLY', 'BI_WEEKLY', 'WEEKLY');
--> statement-breakpoint
CREATE TYPE "public"."tax_regime_type" AS ENUM('OLD', 'NEW');
--> statement-breakpoint
CREATE TYPE "public"."payslip_layout" AS ENUM('CLASSIC', 'MODERN', 'COMPLIANCE');
--> statement-breakpoint
CREATE TYPE "public"."payslip_publish_channel" AS ENUM('PORTAL', 'EMAIL');
--> statement-breakpoint
CREATE TYPE "public"."payroll_calendar_event_type" AS ENUM('ATTENDANCE_CUTOFF', 'REIMBURSEMENT_CUTOFF', 'DECLARATION_CUTOFF', 'PREVIEW_DUE', 'APPROVAL_DEADLINE', 'PAY_DATE', 'PUBLISH_DATE');
--> statement-breakpoint
CREATE TYPE "public"."payroll_loan_adjustment_type" AS ENUM('SKIP_EMI', 'EXTRA_RECOVERY', 'FORECLOSURE', 'MANUAL_ADJUST');
--> statement-breakpoint
CREATE TYPE "public"."whiteboard_visibility" AS ENUM('project', 'private', 'public');
--> statement-breakpoint
CREATE TYPE "public"."whiteboard_share_role" AS ENUM('viewer', 'editor');
--> statement-breakpoint
CREATE TYPE "public"."payroll_template_category" AS ENUM('INDIAN_STANDARD', 'INDIAN_STARTUP', 'CONTRACTOR', 'SALES_INCENTIVE', 'GLOBAL_REMOTE', 'HOURLY', 'MANUFACTURING', 'STAFFING', 'EXECUTIVE', 'CUSTOM');
--> statement-breakpoint
CREATE TYPE "public"."payroll_input_source" AS ENUM('ATTENDANCE', 'LEAVE', 'TIMESHEET', 'UPLOAD', 'MANUAL');
--> statement-breakpoint
CREATE TYPE "public"."payroll_run_event_type" AS ENUM('GENERATED', 'RECALCULATED', 'APPROVAL_SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED', 'REOPENED', 'MARKED_PAID', 'PAYSLIPS_PUBLISHED', 'BANK_BATCH_GENERATED', 'EXCEPTION_OVERRIDDEN', 'INPUT_OVERRIDDEN', 'CLOSED');
--> statement-breakpoint
CREATE TYPE "public"."payslip_publication_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');
--> statement-breakpoint
CREATE TYPE "public"."payroll_tax_window_status" AS ENUM('DRAFT', 'OPEN', 'CLOSED', 'LOCKED');
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "timesheet_exports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"export_type" text DEFAULT 'PAYROLL' NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"date_range_start" date NOT NULL,
	"date_range_end" date NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb,
	"snapshot" jsonb NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"total_hours" numeric(10, 2) DEFAULT '0' NOT NULL,
	"file_url" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "timesheet_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"work_week_start" integer DEFAULT 1 NOT NULL,
	"required_fields" jsonb,
	"rounding_rule" text DEFAULT 'NONE' NOT NULL,
	"max_hours_per_day" numeric(4, 2) DEFAULT '24' NOT NULL,
	"allow_overlapping_entries" boolean DEFAULT true NOT NULL,
	"allow_backdated_entries" boolean DEFAULT true NOT NULL,
	"backdate_limit_days" integer,
	"approval_mode" text DEFAULT 'MANAGER' NOT NULL,
	"client_approval_enabled" boolean DEFAULT false NOT NULL,
	"lock_after_approval" boolean DEFAULT true NOT NULL,
	"lock_after_invoice" boolean DEFAULT true NOT NULL,
	"reminder_rules" jsonb,
	"pay_period" text DEFAULT 'MONTHLY' NOT NULL,
	"overtime_daily_hours" numeric(4, 2) DEFAULT '8' NOT NULL,
	"overtime_weekly_hours" numeric(5, 2) DEFAULT '40' NOT NULL,
	"include_non_billable" boolean DEFAULT true NOT NULL,
	"payroll_mapping" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_settings_org_id_unique" UNIQUE("org_id")
);

--> statement-breakpoint
CREATE TABLE "project_whiteboard_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"whiteboard_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" "whiteboard_share_role" DEFAULT 'viewer' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "interview_panel_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"interview_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "booking_link_interviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_link_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "calibration_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "announcement_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"announcement_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" "payroll_policy_status" DEFAULT 'DRAFT' NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"legal_entity_name" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"pay_day" integer DEFAULT 28 NOT NULL,
	"start_month" text NOT NULL,
	"active_version_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_policy_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer NOT NULL,
	"version" integer NOT NULL,
	"template_key" text,
	"toggles" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"status" "payroll_policy_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_template_activations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_version_id" integer NOT NULL,
	"template_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"activated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer,
	"month" text,
	"type" "payroll_calendar_event_type" NOT NULL,
	"date" date NOT NULL,
	"title" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_accounting_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"component_id" integer,
	"category" text,
	"ledger_name" text NOT NULL,
	"cost_center_source" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_version_id" integer,
	"month" text NOT NULL,
	"status" "payroll_run_status" DEFAULT 'PREPARING' NOT NULL,
	"pay_date" date,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deduction_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employer_cost_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp,
	"locked_by" text,
	"approved_at" timestamp,
	"approved_by" text,
	"paid_at" timestamp,
	"paid_by" text,
	"published_at" timestamp,
	"published_by" text,
	"closed_at" timestamp,
	"closed_by" text,
	"reopened_at" timestamp,
	"reopened_by" text,
	"reopen_reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_run_employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"profile_id" integer,
	"worker_type" "payroll_worker_type" DEFAULT 'EMPLOYEE' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"payout_currency" text,
	"fx_rate" numeric(12, 6),
	"scheduled_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"paid_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"lop_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(6, 2) DEFAULT '0' NOT NULL,
	"gross" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employer_contributions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_payout_currency" numeric(15, 2),
	"status" text DEFAULT 'PENDING' NOT NULL,
	"hold_reason" text,
	"inputs_snapshot" jsonb,
	"calculation_snapshot" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"component_id" integer,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "salary_component_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"calc_method" "salary_component_calc_method" NOT NULL,
	"calc_explain" jsonb NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer,
	"user_id" text,
	"code" text NOT NULL,
	"severity" "payroll_exception_severity" NOT NULL,
	"status" "payroll_exception_status" DEFAULT 'OPEN' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"resolved_by" text,
	"resolved_at" timestamp,
	"override_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"stage" integer NOT NULL,
	"stage_name" text NOT NULL,
	"required_permission" text NOT NULL,
	"status" "payroll_approval_status" DEFAULT 'PENDING' NOT NULL,
	"acted_by" text,
	"acted_at" timestamp,
	"comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payslip_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"layout" "payslip_layout" NOT NULL,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_bank_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"batch_number" text NOT NULL,
	"status" "payroll_bank_batch_status" DEFAULT 'DRAFT' NOT NULL,
	"format" text NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"file_key" text,
	"generated_by" text,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_bank_batch_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"account_masked" text NOT NULL,
	"ifsc" text,
	"status" "payroll_bank_item_status" DEFAULT 'PENDING' NOT NULL,
	"failure_reason" text,
	"transaction_ref" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "salary_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "salary_component_type" NOT NULL,
	"calc_method" "salary_component_calc_method" NOT NULL,
	"amount" numeric(15, 2),
	"percent" numeric(7, 4),
	"formula" text,
	"taxable" boolean DEFAULT false NOT NULL,
	"show_on_payslip" boolean DEFAULT true NOT NULL,
	"include_in_ctc" boolean DEFAULT true NOT NULL,
	"is_statutory" boolean DEFAULT false NOT NULL,
	"statutory_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "employee_salary_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"worker_type" "payroll_worker_type" DEFAULT 'EMPLOYEE' NOT NULL,
	"pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"payout_currency" text,
	"fx_source" text,
	"tax_regime" "tax_regime_type",
	"cost_center" text,
	"annual_ctc" numeric(15, 2) NOT NULL,
	"status" "salary_profile_status" DEFAULT 'ACTIVE' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"policy_version_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "employee_salary_profile_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"profile_id" integer NOT NULL,
	"component_id" integer NOT NULL,
	"calc_method_override" "salary_component_calc_method",
	"amount" numeric(15, 2),
	"percent" numeric(7, 4),
	"formula_override" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_loan_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"run_id" integer,
	"type" "payroll_loan_adjustment_type" NOT NULL,
	"amount" numeric(15, 2),
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "deal_meeting_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"attendee_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "crm_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);

--> statement-breakpoint
CREATE TABLE "crm_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"category" text,
	"unit_price" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tax_rate" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);

--> statement-breakpoint
CREATE TABLE "kb_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer,
	"parent_page_id" integer,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover_image" text,
	"content" jsonb,
	"content_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"last_edited_by_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"public_token" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_type" text DEFAULT 'note' NOT NULL,
	"trust_state" text DEFAULT 'unverified' NOT NULL,
	"owner_user_id" text,
	"verified_by_id" text,
	"verified_until" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"public_slug" text,
	"source_article_id" integer
);

--> statement-breakpoint
CREATE TABLE "kb_page_favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"visited_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_page_id" integer NOT NULL,
	"target_page_id" integer,
	"target_type" text DEFAULT 'page' NOT NULL,
	"target_id" text,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" jsonb,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"author_id" text,
	"parent_id" integer,
	"content" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"description" text,
	"content" jsonb,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_page_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_id" text,
	"reviewer_id" text,
	"due_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_type" text NOT NULL,
	"file_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"succeeded_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"duplicate_items" integer DEFAULT 0 NOT NULL,
	"error_report" jsonb,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "kb_export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" integer,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_key" text,
	"expires_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text,
	"key" text,
	"name" text NOT NULL,
	"description" text,
	"best_for" text,
	"complexity" text,
	"badge" text,
	"category" "payroll_template_category" DEFAULT 'CUSTOM' NOT NULL,
	"default_toggles" jsonb NOT NULL,
	"default_components" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_inputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"source" "payroll_input_source" NOT NULL,
	"scheduled_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"paid_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"lop_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"half_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"shift_allowance_units" numeric(8, 2) DEFAULT '0' NOT NULL,
	"holiday_work_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"is_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"overridden_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"type" "payroll_run_event_type" NOT NULL,
	"actor_id" text,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payslip_publications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"payslip_template_id" integer,
	"pdf_url" text,
	"published_at" timestamp,
	"published_by" text,
	"channel" "payslip_publish_channel" DEFAULT 'PORTAL' NOT NULL,
	"status" "payslip_publication_status" DEFAULT 'PENDING' NOT NULL,
	"snapshot_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "payroll_tax_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"financial_year" text NOT NULL,
	"opens_at" timestamp NOT NULL,
	"closes_at" timestamp NOT NULL,
	"proof_deadline" timestamp,
	"lock_date" date,
	"status" "payroll_tax_window_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "project_whiteboards" ALTER COLUMN "data" SET DEFAULT '{"elements":[]}'::jsonb;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ALTER COLUMN "article_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ALTER COLUMN "org_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ALTER COLUMN "user_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "org_ai_credits" ALTER COLUMN "org_id" SET DATA TYPE text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_org_id" text;
--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "payroll_status" text DEFAULT 'UNPROCESSED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "payroll_export_id" integer;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD COLUMN "visibility" "whiteboard_visibility" DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD COLUMN "public_access" "whiteboard_share_role" DEFAULT 'viewer' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD COLUMN "share_token" text;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD COLUMN "link_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD COLUMN "allow_export" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN "reimbursements_due" numeric(15, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN "asset_recovery" numeric(15, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN "notice_recovery" numeric(15, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN "other_deductions" numeric(15, 2) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN "statement_published_at" timestamp;
--> statement-breakpoint
ALTER TABLE "salary_loans" ADD COLUMN "closed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_user_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "resource_type" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "resource_id" text;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD COLUMN "page_id" integer;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN "type" text DEFAULT 'team' NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN "color" text;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN "default_visibility" text DEFAULT 'org' NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN "owning_team_id" text;
--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ADD CONSTRAINT "timesheet_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheet_exports" ADD CONSTRAINT "timesheet_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheet_settings" ADD CONSTRAINT "timesheet_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_whiteboard_id_project_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."project_whiteboards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" ADD CONSTRAINT "booking_link_interviewers_booking_link_id_interview_booking_links_id_fk" FOREIGN KEY ("booking_link_id") REFERENCES "public"."interview_booking_links"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" ADD CONSTRAINT "booking_link_interviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_session_id_calibration_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."calibration_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_policy_id_payroll_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."payroll_policies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_policy_version_id_payroll_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."payroll_policy_versions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_policy_id_payroll_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."payroll_policies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_accounting_mappings" ADD CONSTRAINT "payroll_accounting_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_policy_version_id_payroll_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."payroll_policy_versions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_templates" ADD CONSTRAINT "payslip_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_batch_id_payroll_bank_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_bank_batches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_profile_id_employee_salary_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."employee_salary_profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_component_id_salary_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."salary_components"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_loan_id_salary_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."salary_loans"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deal_meeting_attendees" ADD CONSTRAINT "deal_meeting_attendees_meeting_id_deal_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."deal_meetings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "deal_meeting_attendees" ADD CONSTRAINT "deal_meeting_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_automation_rules" ADD CONSTRAINT "crm_automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "crm_products" ADD CONSTRAINT "crm_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_last_edited_by_id_users_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_source_page_id_kb_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_target_page_id_kb_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_templates" ADD CONSTRAINT "kb_page_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_templates" ADD CONSTRAINT "kb_page_templates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_import_jobs" ADD CONSTRAINT "kb_import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_import_jobs" ADD CONSTRAINT "kb_import_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_export_jobs" ADD CONSTRAINT "kb_export_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_export_jobs" ADD CONSTRAINT "kb_export_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_templates" ADD CONSTRAINT "payroll_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_payslip_template_id_payslip_templates_id_fk" FOREIGN KEY ("payslip_template_id") REFERENCES "public"."payslip_templates"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payroll_tax_windows" ADD CONSTRAINT "payroll_tax_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "email_outbox_status_next_idx" ON "email_outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "email_outbox_email_created_idx" ON "email_outbox" USING btree ("to_email","created_at");
--> statement-breakpoint
CREATE INDEX "idx_timesheet_exports_org_type_created" ON "timesheet_exports" USING btree ("org_id","export_type","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whiteboard_shares_board_user" ON "project_whiteboard_shares" USING btree ("whiteboard_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_whiteboard_shares_org_board" ON "project_whiteboard_shares" USING btree ("org_id","whiteboard_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_interview_panel_members_interview_user" ON "interview_panel_members" USING btree ("interview_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_interview_panel_members_org_user" ON "interview_panel_members" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_booking_link_interviewers_link_user" ON "booking_link_interviewers" USING btree ("booking_link_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_calibration_participants_session_user" ON "calibration_participants" USING btree ("session_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_calibration_participants_org_user" ON "calibration_participants" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_announcement_targets_announcement" ON "announcement_targets" USING btree ("announcement_id");
--> statement-breakpoint
CREATE INDEX "idx_announcement_targets_org_type_target" ON "announcement_targets" USING btree ("org_id","target_type","target_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_policies_org" ON "payroll_policies" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_policies_org_status" ON "payroll_policies" USING btree ("org_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_policy_versions_policy_version" ON "payroll_policy_versions" USING btree ("policy_id","version");
--> statement-breakpoint
CREATE INDEX "idx_payroll_policy_versions_org_policy" ON "payroll_policy_versions" USING btree ("org_id","policy_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_template_activations_org" ON "payroll_template_activations" USING btree ("org_id","policy_version_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_calendar_events_org_date" ON "payroll_calendar_events" USING btree ("org_id","date");
--> statement-breakpoint
CREATE INDEX "idx_payroll_accounting_mappings_org" ON "payroll_accounting_mappings" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_runs_org_month" ON "payroll_runs" USING btree ("org_id","month");
--> statement-breakpoint
CREATE INDEX "idx_payroll_runs_org_status" ON "payroll_runs" USING btree ("org_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_run_employees_run_user" ON "payroll_run_employees" USING btree ("run_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_run_employees_org_run" ON "payroll_run_employees" USING btree ("org_id","run_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_run_employee" ON "payroll_line_items" USING btree ("run_employee_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_org_run" ON "payroll_line_items" USING btree ("org_id","run_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_exceptions_org_run_status" ON "payroll_exceptions" USING btree ("org_id","run_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_approvals_run_stage" ON "payroll_approvals" USING btree ("run_id","stage");
--> statement-breakpoint
CREATE INDEX "idx_payroll_approvals_org_run" ON "payroll_approvals" USING btree ("org_id","run_id");
--> statement-breakpoint
CREATE INDEX "idx_payslip_templates_org" ON "payslip_templates" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_bank_batches_org_number" ON "payroll_bank_batches" USING btree ("org_id","batch_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_bank_batches_idempotency_key" ON "payroll_bank_batches" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batches_org_run" ON "payroll_bank_batches" USING btree ("org_id","run_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batch_items_batch_status" ON "payroll_bank_batch_items" USING btree ("batch_id","status");
--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batch_items_org" ON "payroll_bank_batch_items" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_salary_components_org_code" ON "salary_components" USING btree ("org_id","code");
--> statement-breakpoint
CREATE INDEX "idx_salary_components_org_active" ON "salary_components" USING btree ("org_id","is_active");
--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profiles_org_user_effective" ON "employee_salary_profiles" USING btree ("org_id","user_id","effective_from");
--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profiles_org_status" ON "employee_salary_profiles" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profile_components_profile" ON "employee_salary_profile_components" USING btree ("profile_id");
--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profile_components_org" ON "employee_salary_profile_components" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_loan_adjustments_org_loan" ON "payroll_loan_adjustments" USING btree ("org_id","loan_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_loan_adjustments_run" ON "payroll_loan_adjustments" USING btree ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deal_meeting_attendees_unique" ON "deal_meeting_attendees" USING btree ("meeting_id","attendee_id");
--> statement-breakpoint
CREATE INDEX "idx_crm_automation_rules_org" ON "crm_automation_rules" USING btree ("org_id","is_active","created_at");
--> statement-breakpoint
CREATE INDEX "idx_crm_automation_rules_deleted" ON "crm_automation_rules" USING btree ("deleted_at");
--> statement-breakpoint
CREATE INDEX "idx_crm_products_org" ON "crm_products" USING btree ("org_id","is_active","created_at");
--> statement-breakpoint
CREATE INDEX "idx_crm_products_deleted" ON "crm_products" USING btree ("deleted_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_parent_sort" ON "kb_pages" USING btree ("org_id","parent_page_id","sort_order");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_deleted" ON "kb_pages" USING btree ("org_id","deleted_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_updated" ON "kb_pages" USING btree ("org_id","updated_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_parent" ON "kb_pages" USING btree ("parent_page_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_public_token" ON "kb_pages" USING btree ("public_token");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_status" ON "kb_pages" USING btree ("org_id","status");
--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_next_review" ON "kb_pages" USING btree ("org_id","next_review_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_org_public_slug" ON "kb_pages" USING btree ("org_id","public_slug") WHERE "kb_pages"."public_slug" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_org_source_article" ON "kb_pages" USING btree ("org_id","source_article_id") WHERE "kb_pages"."source_article_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_favorites_page_user" ON "kb_page_favorites" USING btree ("page_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_favorites_org_user" ON "kb_page_favorites" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_visits_page_user" ON "kb_page_visits" USING btree ("page_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_visits_org_user_visited" ON "kb_page_visits" USING btree ("org_id","user_id","visited_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_links_source_target" ON "kb_page_links" USING btree ("source_page_id","target_page_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_links_org_target" ON "kb_page_links" USING btree ("org_id","target_page_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_versions_page_version" ON "kb_page_versions" USING btree ("page_id","version_number");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_comments_org_page" ON "kb_page_comments" USING btree ("org_id","page_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_templates_org" ON "kb_page_templates" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_reviews_org_status_due" ON "kb_page_reviews" USING btree ("org_id","status","due_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_page_reviews_org_page" ON "kb_page_reviews" USING btree ("org_id","page_id");
--> statement-breakpoint
CREATE INDEX "idx_kb_import_jobs_org_created" ON "kb_import_jobs" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_export_jobs_org_created" ON "kb_export_jobs" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_org" ON "payroll_templates" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_system" ON "payroll_templates" USING btree ("is_system");
--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_category" ON "payroll_templates" USING btree ("category");
--> statement-breakpoint
CREATE INDEX "idx_payroll_inputs_run" ON "payroll_inputs" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_inputs_org_user" ON "payroll_inputs" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_inputs_run_user" ON "payroll_inputs" USING btree ("run_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_run" ON "payroll_run_events" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_org_type" ON "payroll_run_events" USING btree ("org_id","type");
--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_org_created" ON "payroll_run_events" USING btree ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_run" ON "payslip_publications" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_user" ON "payslip_publications" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_org_status" ON "payslip_publications" USING btree ("org_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payslip_publications_run_employee" ON "payslip_publications" USING btree ("run_employee_id");
--> statement-breakpoint
CREATE INDEX "idx_payroll_tax_windows_org" ON "payroll_tax_windows" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_tax_windows_org_year" ON "payroll_tax_windows" USING btree ("org_id","financial_year");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_active_org_id_organizations_id_fk" FOREIGN KEY ("last_active_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_payroll_export_id_timesheet_exports_id_fk" FOREIGN KEY ("payroll_export_id") REFERENCES "public"."timesheet_exports"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD CONSTRAINT "ai_credit_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD CONSTRAINT "ai_credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_ai_credits" ADD CONSTRAINT "org_ai_credits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_users_last_active_org" ON "users" USING btree ("last_active_org_id");
--> statement-breakpoint
CREATE INDEX "idx_timesheets_org_payroll" ON "timesheets" USING btree ("org_id","payroll_status","date");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_whiteboards_share_token" ON "project_whiteboards" USING btree ("share_token");
--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("org_id","resource_type","created_at");
--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_org_page" ON "kb_article_chunks" USING btree ("org_id","page_id");
--> statement-breakpoint
CREATE INDEX "idx_user_memberships_dept" ON "user_memberships" USING btree ("department_id");
--> statement-breakpoint
CREATE INDEX "idx_user_memberships_branch" ON "user_memberships" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX "idx_user_memberships_team" ON "user_memberships" USING btree ("team_id");
--> statement-breakpoint
CREATE INDEX "idx_user_memberships_bu" ON "user_memberships" USING btree ("business_unit_id");
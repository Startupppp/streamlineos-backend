-- `current_org_id()` appears unqualified 62 times below.
--
-- This file is a snapshot of a database whose search_path reaches the `app`
-- schema; this journal only ever creates `app.current_org_id` (0374), so the
-- bare calls resolve to nothing and the migration aborts on the first policy.
-- Setting the path for this file resolves them to that same function, and
-- PostgreSQL stores the resolved, schema-qualified reference in each policy —
-- so the result is identical to having written `app.` at every call site. The
-- bootstrapper gives each migration its own connection, so this reaches no
-- other file.
SET search_path = public, app;
--> statement-breakpoint
-- Objects the running control plane has that the committed migration chain never creates.
--
-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=forward.
-- A cold build of a cell reaches head and is still short of these, so the chain cannot
-- reproduce the database it is supposed to describe. Every statement is idempotent, so
-- this file is a no-op against the control plane that supplied it.

--
-- enum types the chain never creates (39)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'acct_document_status') THEN
    CREATE TYPE "public"."acct_document_status" AS ENUM ('DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'VOID');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'acct_settlement_status') THEN
    CREATE TYPE "public"."acct_settlement_status" AS ENUM ('POSTED', 'REVERSED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'ap_document_type') THEN
    CREATE TYPE "public"."ap_document_type" AS ENUM ('BILL', 'DEBIT_NOTE');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'ar_document_type') THEN
    CREATE TYPE "public"."ar_document_type" AS ENUM ('INVOICE', 'CREDIT_NOTE');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'automation_run_status') THEN
    CREATE TYPE "public"."automation_run_status" AS ENUM ('success', 'failed', 'skipped');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'automation_trigger') THEN
    CREATE TYPE "public"."automation_trigger" AS ENUM ('lead.created', 'lead.status_changed', 'lead.assigned', 'lead.score_updated', 'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'ticket.created', 'ticket.assigned', 'ticket.status_changed', 'ticket.priority_changed', 'ticket.message_received', 'ticket.escalated', 'invoice.overdue', 'invoice.paid', 'candidate.application_created', 'candidate.stage_changed', 'candidate.bgv_status_changed', 'interview.scheduled', 'interview.completed', 'scorecard.submitted', 'offer.sent', 'offer.accepted', 'offer.rejected', 'sla.breached', 'onboarding.started', 'onboarding.task_overdue', 'onboarding.document_submitted', 'onboarding.completed', 'leave.requested', 'leave.approved', 'leave.rejected', 'attendance.anomaly', 'attendance.late', 'resignation.submitted', 'resignation.approved', 'employee.onboarded', 'employee.terminated', 'employee.resignation', 'certification.expiring', 'document.review_requested', 'performance.review_cycle_started', 'review.cycle_started', 'expense.submitted', 'expense.approved', 'reimbursement.approved', 'reimbursement.rejected', 'sign.envelope.sent', 'sign.envelope.completed', 'sign.envelope.declined', 'sign.envelope.voided', 'sign.envelope.expired', 'sign.recipient.completed', 'sign.bulk_send.completed');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'bank_identifier_scheme') THEN
    CREATE TYPE "public"."bank_identifier_scheme" AS ENUM ('IFSC_ACCOUNT', 'IBAN', 'ROUTING_ACCOUNT', 'SORT_ACCOUNT', 'BSB_ACCOUNT', 'UPI', 'OTHER');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'bank_match_kind') THEN
    CREATE TYPE "public"."bank_match_kind" AS ENUM ('receipt', 'payment', 'journal');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'bank_statement_source') THEN
    CREATE TYPE "public"."bank_statement_source" AS ENUM ('csv', 'manual', 'feed');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'branch_status') THEN
    CREATE TYPE "public"."branch_status" AS ENUM ('ACTIVE', 'INACTIVE');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'cell_ceiling_source') THEN
    CREATE TYPE "public"."cell_ceiling_source" AS ENUM ('measured', 'vendor-declared', 'operational-judgment');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'compliance_enforcement') THEN
    CREATE TYPE "public"."compliance_enforcement" AS ENUM ('off', 'warn', 'block_send', 'block_post');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'compliance_status') THEN
    CREATE TYPE "public"."compliance_status" AS ENUM ('not_required', 'pending', 'submitted', 'accepted', 'rejected', 'cancelled');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'compliance_transport') THEN
    CREATE TYPE "public"."compliance_transport" AS ENUM ('none', 'irp', 'peppol', 'fatoora', 'sdi', 'mtd', 'other');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'crm_event_status') THEN
    CREATE TYPE "public"."crm_event_status" AS ENUM ('planning', 'confirmed', 'completed');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'deal_activity_type') THEN
    CREATE TYPE "public"."deal_activity_type" AS ENUM ('stage_change', 'note', 'call', 'email', 'meeting', 'document');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'delivery_status') THEN
    CREATE TYPE "public"."delivery_status" AS ENUM ('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED', 'EXPIRED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_account_type') THEN
    CREATE TYPE "public"."gl_account_type" AS ENUM ('ASSET', 'CONTRA_ASSET', 'LIABILITY', 'CONTRA_LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_book_status') THEN
    CREATE TYPE "public"."gl_book_status" AS ENUM ('ACTIVE', 'ARCHIVED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_fiscal_year_status') THEN
    CREATE TYPE "public"."gl_fiscal_year_status" AS ENUM ('OPEN', 'CLOSED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_journal_source') THEN
    CREATE TYPE "public"."gl_journal_source" AS ENUM ('manual', 'opening_balance', 'sales_invoice', 'credit_note', 'receipt', 'purchase_bill', 'debit_note', 'payment', 'bank_fee', 'bank_transfer', 'payroll_run', 'expense_claim', 'billing_invoice', 'withholding', 'fx_reval', 'depreciation', 'stock_move', 'period_close');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_period_status') THEN
    CREATE TYPE "public"."gl_period_status" AS ENUM ('OPEN', 'LOCKED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'gl_system_tag') THEN
    CREATE TYPE "public"."gl_system_tag" AS ENUM ('cash', 'bank', 'undeposited', 'ar_control', 'ap_control', 'sales', 'other_income', 'cogs', 'opex', 'salary', 'equity_capital', 'retained_earnings', 'current_year_earnings', 'fx_gain', 'fx_loss', 'rounding', 'vat_input', 'vat_output', 'sales_tax_payable', 'wht_payable', 'gst_input_cgst', 'gst_input_sgst', 'gst_input_igst', 'gst_input_utgst', 'gst_input_cess', 'gst_output_cgst', 'gst_output_sgst', 'gst_output_igst', 'gst_output_utgst', 'gst_output_cess', 'psp_clearing', 'razorpay_clearing', 'stripe_clearing', 'payment_fees', 'net_pay_clearing', 'statutory_payable', 'fixed_asset', 'accum_depreciation', 'depreciation_expense', 'deferred_revenue', 'inventory');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'hr_automation_run_status') THEN
    CREATE TYPE "public"."hr_automation_run_status" AS ENUM ('success', 'partial', 'failed', 'skipped');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'hr_custom_field_type') THEN
    CREATE TYPE "public"."hr_custom_field_type" AS ENUM ('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'file', 'employee_ref', 'department_ref', 'currency');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'inv_import_row_status') THEN
    CREATE TYPE "public"."inv_import_row_status" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'SKIPPED');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'inv_quantity_bucket') THEN
    CREATE TYPE "public"."inv_quantity_bucket" AS ENUM ('ON_HAND', 'BLOCKED', 'QUALITY_HOLD');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'onboarding_flow_task_category') THEN
    CREATE TYPE "public"."onboarding_flow_task_category" AS ENUM ('profile', 'document', 'training', 'system_access', 'equipment', 'policy', 'module_setup', 'guided_action', 'payment_setup');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'onboarding_flow_task_status') THEN
    CREATE TYPE "public"."onboarding_flow_task_status" AS ENUM ('todo', 'in_progress', 'done', 'skipped');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'party_role') THEN
    CREATE TYPE "public"."party_role" AS ENUM ('customer', 'vendor', 'both');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'payroll_status') THEN
    CREATE TYPE "public"."payroll_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'principal_group_type') THEN
    CREATE TYPE "public"."principal_group_type" AS ENUM ('department', 'team', 'custom');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'support_source_channel') THEN
    CREATE TYPE "public"."support_source_channel" AS ENUM ('web', 'portal', 'email', 'chat', 'whatsapp', 'sms', 'api', 'internal');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'task_type') THEN
    CREATE TYPE "public"."task_type" AS ENUM ('CALL', 'EMAIL', 'MEETING', 'CUSTOM');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'tax_category') THEN
    CREATE TYPE "public"."tax_category" AS ENUM ('standard', 'reduced', 'super_reduced', 'zero', 'exempt', 'out_of_scope', 'reverse_charge');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'tax_gl_role') THEN
    CREATE TYPE "public"."tax_gl_role" AS ENUM ('output_payable', 'input_recoverable', 'reverse_charge_output', 'reverse_charge_input', 'blocked_input', 'withheld');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'tax_regime') THEN
    CREATE TYPE "public"."tax_regime" AS ENUM ('GST_IN', 'VAT_EU', 'VAT_GB', 'VAT_GCC', 'GST_SG', 'GST_AU', 'GST_HST_CA', 'SALES_TAX_US', 'PAN_IN', 'TAN_IN', 'EIN_US', 'GENERIC');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'tax_registration_owner') THEN
    CREATE TYPE "public"."tax_registration_owner" AS ENUM ('book', 'party');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'tax_supply_nature') THEN
    CREATE TYPE "public"."tax_supply_nature" AS ENUM ('domestic_b2b', 'domestic_b2c', 'export', 'import', 'intra_community', 'oss_b2c', 'reverse_charge', 'outside_scope');
  END IF;
END $repair$;
--> statement-breakpoint
--
-- tables (65)
--
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."relationship_states" (
  "relationship_state_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text,
  "deal_id" text,
  "observed_from" timestamp without time zone,
  "last_contact_at" timestamp without time zone,
  "last_inbound_at" timestamp without time zone,
  "last_outbound_at" timestamp without time zone,
  "last_inbound_activity_id" text,
  "last_outbound_activity_id" text,
  "awaiting_reply_since" timestamp without time zone,
  "contact_count" integer DEFAULT 0 NOT NULL,
  "inbound_count" integer DEFAULT 0 NOT NULL,
  "outbound_count" integer DEFAULT 0 NOT NULL,
  "unreadable_direction_count" integer DEFAULT 0 NOT NULL,
  "reply_sample_count" integer DEFAULT 0 NOT NULL,
  "reply_p50_seconds" integer,
  "reply_p90_seconds" integer,
  "reply_min_seconds" integer,
  "reply_max_seconds" integer,
  "participant_count" integer DEFAULT 0 NOT NULL,
  "thread_count" integer DEFAULT 0 NOT NULL,
  "built_at" timestamp without time zone DEFAULT now() NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_books" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "legal_entity_id" text,
  "name" text NOT NULL,
  "country_code" text NOT NULL,
  "base_currency" text NOT NULL,
  "localization_pack" text NOT NULL,
  "fiscal_year_start_month" integer DEFAULT 4 NOT NULL,
  "fiscal_year_start_day" integer DEFAULT 1 NOT NULL,
  "timezone" text DEFAULT 'Asia/Kolkata'::text NOT NULL,
  "parent_book_id" text,
  "is_default" boolean DEFAULT true NOT NULL,
  "status" gl_book_status DEFAULT 'ACTIVE'::gl_book_status NOT NULL,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_fx_rates" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "from_code" text NOT NULL,
  "to_code" text NOT NULL,
  "rate_date" date NOT NULL,
  "rate" numeric(18,10) NOT NULL,
  "source" text DEFAULT 'manual'::text NOT NULL,
  "captured_at" timestamp without time zone DEFAULT now() NOT NULL,
  "created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_periods" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "fiscal_year_id" text NOT NULL,
  "name" text NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date NOT NULL,
  "sequence" integer NOT NULL,
  "status" gl_period_status DEFAULT 'OPEN'::gl_period_status NOT NULL,
  "locked_by" text,
  "locked_at" timestamp without time zone,
  "lock_reason" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ap_withholding" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "payment_id" text NOT NULL,
  "document_id" text,
  "regime" text DEFAULT 'GENERIC_WHT'::text NOT NULL,
  "legacy_section" text,
  "payment_code" text,
  "rate_bp" integer NOT NULL,
  "base_minor" bigint NOT NULL,
  "withheld_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "gl_account_id" text,
  "remittance_reference" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."relationship_threads" (
  "relationship_thread_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "relationship_state_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "subject" text,
  "first_seen_at" timestamp without time zone NOT NULL,
  "last_seen_at" timestamp without time zone NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "last_direction" text,
  "preceded_by_thread_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."relationship_participants" (
  "relationship_participant_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "relationship_state_id" text NOT NULL,
  "identity" text NOT NULL,
  "party_id" text,
  "user_id" text,
  "address" text,
  "roles" text[] DEFAULT '{}'::text[] NOT NULL,
  "first_seen_at" timestamp without time zone NOT NULL,
  "last_seen_at" timestamp without time zone NOT NULL,
  "message_count" integer DEFAULT 0 NOT NULL,
  "replied_count" integer DEFAULT 0 NOT NULL,
  "last_replied_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_journals" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "period_id" text NOT NULL,
  "journal_number" text NOT NULL,
  "journal_date" date NOT NULL,
  "memo" text,
  "source_type" gl_journal_source NOT NULL,
  "source_id" text,
  "idempotency_key" text NOT NULL,
  "reverses_journal_id" text,
  "reversed_by_journal_id" text,
  "posted_by_user_id" text,
  "posted_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ar_document_lines" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "document_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "description" text NOT NULL,
  "quantity_milli" bigint DEFAULT 1000 NOT NULL,
  "unit" text,
  "unit_price_minor" bigint DEFAULT 0 NOT NULL,
  "discount_minor" bigint DEFAULT 0 NOT NULL,
  "tax_category" tax_category DEFAULT 'standard'::tax_category NOT NULL,
  "commodity_code" text,
  "forced_tax_code_id" text,
  "forced_tax_reason" text,
  "income_account_id" text,
  "line_net_minor" bigint DEFAULT 0 NOT NULL,
  "line_tax_minor" bigint DEFAULT 0 NOT NULL,
  "line_gross_minor" bigint DEFAULT 0 NOT NULL,
  "dimension_project_id" integer,
  "dimension_cost_center_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ar_receipts" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "party_id" text NOT NULL,
  "receipt_number" text,
  "receipt_date" date NOT NULL,
  "deposit_account_id" text NOT NULL,
  "currency" text NOT NULL,
  "fx_rate" numeric(18,10) DEFAULT '1'::numeric NOT NULL,
  "amount_minor" bigint NOT NULL,
  "unapplied_minor" bigint DEFAULT 0 NOT NULL,
  "status" acct_settlement_status DEFAULT 'POSTED'::acct_settlement_status NOT NULL,
  "payment_method" text,
  "reference" text,
  "memo" text,
  "provider_payment_id" text,
  "posted_journal_id" text,
  "reversal_journal_id" text,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ap_payments" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "party_id" text NOT NULL,
  "payment_number" text,
  "payment_date" date NOT NULL,
  "payment_account_id" text NOT NULL,
  "currency" text NOT NULL,
  "fx_rate" numeric(18,10) DEFAULT '1'::numeric NOT NULL,
  "gross_minor" bigint NOT NULL,
  "withheld_minor" bigint DEFAULT 0 NOT NULL,
  "net_paid_minor" bigint NOT NULL,
  "unapplied_minor" bigint DEFAULT 0 NOT NULL,
  "status" acct_settlement_status DEFAULT 'POSTED'::acct_settlement_status NOT NULL,
  "payment_method" text,
  "reference" text,
  "memo" text,
  "posted_journal_id" text,
  "reversal_journal_id" text,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bank_matches" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "statement_line_id" text NOT NULL,
  "kind" bank_match_kind NOT NULL,
  "receipt_id" text,
  "payment_id" text,
  "journal_id" text,
  "matched_by" text,
  "matched_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_document_attachments" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "storage_url" text,
  "uploaded_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_document_compliance" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "transport" compliance_transport DEFAULT 'none'::compliance_transport NOT NULL,
  "status" compliance_status DEFAULT 'not_required'::compliance_status NOT NULL,
  "enforcement_at_post" compliance_enforcement DEFAULT 'off'::compliance_enforcement NOT NULL,
  "authority_id" text,
  "ack_no" text,
  "ack_at" timestamp without time zone,
  "payload_r2_key" text,
  "qr_r2_key" text,
  "schema_version" text,
  "errors" jsonb,
  "attempt_count" text,
  "last_attempt_at" timestamp without time zone,
  "cancelled_at" timestamp without time zone,
  "cancel_reason" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."tax_codes" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "pack" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category" tax_category DEFAULT 'standard'::tax_category NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "description" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."subprocessors" (
  "subprocessor_id" text NOT NULL,
  "name" text NOT NULL,
  "purpose" text NOT NULL,
  "location" text NOT NULL,
  "url" text,
  "effective_from" timestamp without time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ap_document_lines" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "document_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "description" text NOT NULL,
  "quantity_milli" bigint DEFAULT 1000 NOT NULL,
  "unit" text,
  "unit_price_minor" bigint DEFAULT 0 NOT NULL,
  "discount_minor" bigint DEFAULT 0 NOT NULL,
  "tax_category" tax_category DEFAULT 'standard'::tax_category NOT NULL,
  "commodity_code" text,
  "forced_tax_code_id" text,
  "forced_tax_reason" text,
  "expense_account_id" text,
  "capitalize" boolean DEFAULT false NOT NULL,
  "line_net_minor" bigint DEFAULT 0 NOT NULL,
  "line_tax_minor" bigint DEFAULT 0 NOT NULL,
  "line_gross_minor" bigint DEFAULT 0 NOT NULL,
  "dimension_project_id" integer,
  "dimension_cost_center_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."subject_requests" (
  "subject_request_id" text NOT NULL,
  "kind" text NOT NULL,
  "subject_email" text NOT NULL,
  "region_outcomes" jsonb,
  "is_complete" text NOT NULL,
  "total_records_affected" integer DEFAULT 0 NOT NULL,
  "backups_expire_by" text,
  "due_by" timestamp without time zone,
  "requested_at" timestamp without time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_deal_forecast_scores" (
  "crm_deal_forecast_score_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "deal_id" integer NOT NULL,
  "crm_deal_forecast_model_id" text NOT NULL,
  "as_of" timestamp without time zone NOT NULL,
  "scored_at" timestamp without time zone DEFAULT now() NOT NULL,
  "probability" double precision NOT NULL,
  "interval_lower" double precision NOT NULL,
  "interval_upper" double precision NOT NULL,
  "expected_value_minor" bigint NOT NULL,
  "features" jsonb NOT NULL,
  "factors" jsonb NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_deal_forecast_models" (
  "crm_deal_forecast_model_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "feature_spec_version" text NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "trained_at" timestamp without time zone DEFAULT now() NOT NULL,
  "became_available_at" timestamp without time zone DEFAULT now() NOT NULL,
  "training_deals" integer NOT NULL,
  "holdout_deals" integer NOT NULL,
  "won_deals" integer NOT NULL,
  "lost_deals" integer NOT NULL,
  "coefficients" jsonb NOT NULL,
  "evaluation" jsonb NOT NULL,
  "ridge" double precision NOT NULL,
  "iterations" integer NOT NULL,
  "converged" boolean NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."autonomy_repair_policies" (
  "autonomy_repair_policy_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "repair_class" text NOT NULL,
  "enabled" boolean NOT NULL,
  "reason" text,
  "updated_by_user_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_fiscal_years" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "name" text NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date NOT NULL,
  "status" gl_fiscal_year_status DEFAULT 'OPEN'::gl_fiscal_year_status NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."autonomy_repairs" (
  "autonomy_repair_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "autonomous_decision_id" text NOT NULL,
  "repair_class" text NOT NULL,
  "finding_id" text,
  "party_id" text NOT NULL,
  "field" text NOT NULL,
  "previous_value" text,
  "repaired_value" text,
  "applied_at" timestamp without time zone DEFAULT now() NOT NULL,
  "reverted_at" timestamp without time zone,
  "reverted_by_user_id" text,
  "reverted_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."tax_document_lines" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "document_line_id" text,
  "tax_code_id" text,
  "component" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "taxable_minor" bigint NOT NULL,
  "tax_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "gl_role" tax_gl_role NOT NULL,
  "recoverable" boolean DEFAULT false NOT NULL,
  "gl_account_id" text,
  "raw_result" jsonb,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_currencies" (
  "code" text NOT NULL,
  "name" text NOT NULL,
  "minor_units" integer NOT NULL,
  "symbol" text,
  "is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ap_documents" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "party_id" text NOT NULL,
  "document_type" ap_document_type NOT NULL,
  "status" acct_document_status DEFAULT 'DRAFT'::acct_document_status NOT NULL,
  "document_number" text,
  "vendor_document_number" text,
  "vendor_document_date" date,
  "issue_date" date NOT NULL,
  "due_date" date,
  "currency" text NOT NULL,
  "fx_rate" numeric(18,10) DEFAULT '1'::numeric NOT NULL,
  "supply_nature" tax_supply_nature DEFAULT 'domestic_b2b'::tax_supply_nature NOT NULL,
  "tax_location_from_country" text,
  "tax_location_from_region" text,
  "tax_location_to_country" text,
  "tax_location_to_region" text,
  "place_of_supply_code" text,
  "tax_inclusive" boolean DEFAULT false NOT NULL,
  "reverse_charge" boolean DEFAULT false NOT NULL,
  "blocked_input_tax" boolean DEFAULT false NOT NULL,
  "net_minor" bigint DEFAULT 0 NOT NULL,
  "tax_minor" bigint DEFAULT 0 NOT NULL,
  "gross_minor" bigint DEFAULT 0 NOT NULL,
  "rounding_minor" bigint DEFAULT 0 NOT NULL,
  "functional_gross_minor" bigint DEFAULT 0 NOT NULL,
  "settled_minor" bigint DEFAULT 0 NOT NULL,
  "original_document_id" text,
  "posted_journal_id" text,
  "memo" text,
  "reference" text,
  "gstr_period" text,
  "ims_status" text,
  "dimension_project_id" integer,
  "posted_by" text,
  "posted_at" timestamp without time zone,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_outbound_messages" (
  "outbound_message_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "contact_id" integer,
  "deal_id" text,
  "outbound_class" text NOT NULL,
  "track" text NOT NULL,
  "channel" text DEFAULT 'EMAIL'::text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "recipient_email" text,
  "status" text DEFAULT 'drafted'::text NOT NULL,
  "blocked_reason" text,
  "working_hour_deferrals" integer DEFAULT 0 NOT NULL,
  "timezone_used" text,
  "timezone_source" text,
  "autonomous_decision_id" text NOT NULL,
  "model" text,
  "prompt_version" text,
  "sent_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_outbound_class_stops" (
  "outbound_class_stop_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "outbound_class" text NOT NULL,
  "outbound_message_id" text,
  "reason" text,
  "stopped_by_user_id" text,
  "stopped_at" timestamp without time zone DEFAULT now() NOT NULL,
  "released_at" timestamp without time zone,
  "released_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_cold_outbound_settings" (
  "organization_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "enabled_at" timestamp without time zone,
  "enabled_by_user_id" text,
  "paused_at" timestamp without time zone,
  "pause_reason" text,
  "paused_by_user_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_sending_domains" (
  "sending_domain_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "domain" text NOT NULL,
  "purpose" text NOT NULL,
  "verified_at" timestamp without time zone,
  "warmup_started_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."inv_import_rows" (
  "id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  "org_id" text NOT NULL,
  "job_id" integer NOT NULL,
  "row_number" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "status" inv_import_row_status DEFAULT 'PENDING'::inv_import_row_status NOT NULL,
  "error_code" text,
  "error_field" text,
  "error_message" text,
  "applied_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ap_allocations" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "payment_id" text,
  "debit_note_id" text,
  "document_id" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bank_profiles" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "account_id" text NOT NULL,
  "display_name" text NOT NULL,
  "bank_name" text,
  "currency" text NOT NULL,
  "country_code" text NOT NULL,
  "identifier_scheme" bank_identifier_scheme,
  "identifier_value" text,
  "branch_identifier" text,
  "csv_mapping" jsonb,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ar_documents" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "party_id" text NOT NULL,
  "document_type" ar_document_type NOT NULL,
  "status" acct_document_status DEFAULT 'DRAFT'::acct_document_status NOT NULL,
  "document_number" text,
  "issue_date" date NOT NULL,
  "due_date" date,
  "currency" text NOT NULL,
  "fx_rate" numeric(18,10) DEFAULT '1'::numeric NOT NULL,
  "supply_nature" tax_supply_nature DEFAULT 'domestic_b2b'::tax_supply_nature NOT NULL,
  "tax_location_from_country" text,
  "tax_location_from_region" text,
  "tax_location_to_country" text,
  "tax_location_to_region" text,
  "place_of_supply_code" text,
  "tax_inclusive" boolean DEFAULT false NOT NULL,
  "net_minor" bigint DEFAULT 0 NOT NULL,
  "tax_minor" bigint DEFAULT 0 NOT NULL,
  "gross_minor" bigint DEFAULT 0 NOT NULL,
  "rounding_minor" bigint DEFAULT 0 NOT NULL,
  "functional_gross_minor" bigint DEFAULT 0 NOT NULL,
  "settled_minor" bigint DEFAULT 0 NOT NULL,
  "original_document_id" text,
  "posted_journal_id" text,
  "memo" text,
  "reference" text,
  "irn" text,
  "irn_ack_no" text,
  "irn_ack_at" timestamp without time zone,
  "signed_qr" text,
  "irp_status" text,
  "gstr_period" text,
  "ecommerce_gstin" text,
  "export_with_igst" boolean DEFAULT false NOT NULL,
  "crm_deal_id" text,
  "dimension_project_id" integer,
  "posted_by" text,
  "posted_at" timestamp without time zone,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone,
  "pdf_storage_key" text,
  "pdf_storage_url" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_parties" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "role" party_role DEFAULT 'customer'::party_role NOT NULL,
  "display_name" text NOT NULL,
  "legal_name" text,
  "email" text,
  "phone" text,
  "country_code" text NOT NULL,
  "default_currency" text NOT NULL,
  "billing_line1" text,
  "billing_line2" text,
  "billing_city" text,
  "billing_region" text,
  "billing_postal_code" text,
  "billing_country_code" text,
  "shipping_line1" text,
  "shipping_city" text,
  "shipping_region" text,
  "shipping_postal_code" text,
  "shipping_country_code" text,
  "external_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "default_income_account_id" text,
  "default_expense_account_id" text,
  "payment_terms_days" integer DEFAULT 30 NOT NULL,
  "withholding_code" text,
  "notes" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_accounts" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "account_type" gl_account_type NOT NULL,
  "parent_account_id" text,
  "is_header" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_cash" boolean DEFAULT false NOT NULL,
  "system_tag" gl_system_tag,
  "currency_restriction" text,
  "description" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp without time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."ar_allocations" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "receipt_id" text,
  "credit_note_id" text,
  "document_id" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_journal_lines" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "journal_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "account_id" text NOT NULL,
  "debit_minor" bigint DEFAULT 0 NOT NULL,
  "credit_minor" bigint DEFAULT 0 NOT NULL,
  "txn_currency" text NOT NULL,
  "txn_amount_minor" bigint NOT NULL,
  "functional_currency" text NOT NULL,
  "functional_amount_minor" bigint NOT NULL,
  "fx_rate" numeric(18,10) DEFAULT '1'::numeric NOT NULL,
  "fx_rate_id" text,
  "party_id" text,
  "tax_code_id" text,
  "tax_component" text,
  "dimension_branch_id" text,
  "dimension_project_id" integer,
  "dimension_cost_center_id" text,
  "dimension_values" jsonb,
  "description" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."tax_registrations" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "owner_type" tax_registration_owner NOT NULL,
  "book_id" text,
  "party_id" text,
  "regime" tax_regime NOT NULL,
  "number" text NOT NULL,
  "region" text,
  "country_code" text NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "valid_from" date,
  "valid_to" date,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_document_sequences" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "kind" text NOT NULL,
  "fiscal_year_id" text,
  "prefix" text NOT NULL,
  "pattern" text NOT NULL,
  "padding" integer DEFAULT 4 NOT NULL,
  "next_number" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_org_party_map" (
  "organization_id" text NOT NULL,
  "crm_organization_id" integer DEFAULT nextval('crm_organizations_id_seq'::regclass) NOT NULL,
  "party_id" text NOT NULL,
  "linked_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."subprocessor_subscribers" (
  "subprocessor_subscriber_id" text NOT NULL,
  "email" text NOT NULL,
  "organization_id" text,
  "unsubscribed_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."tax_gl_map" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "gl_role" tax_gl_role NOT NULL,
  "component" text NOT NULL,
  "account_id" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."tax_rates" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "tax_code_id" text NOT NULL,
  "component" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_call_recording_consent" (
  "call_recording_consent_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "org_party_consented_at" timestamp without time zone,
  "org_party_method" text,
  "counterparty_consented_at" timestamp without time zone,
  "counterparty_method" text,
  "counterparty_withdrawn_at" timestamp without time zone,
  "note" text,
  "attested_by_user_id" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_call_analysis_releases" (
  "call_analysis_release_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "analyzer_version" integer NOT NULL,
  "released_by_user_id" text NOT NULL,
  "note" text,
  "released_at" timestamp without time zone DEFAULT now() NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_call_analyses" (
  "call_analysis_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "transcript_hash" text NOT NULL,
  "analyzer_version" integer NOT NULL,
  "activity_id" text NOT NULL,
  "talk_ratio_bps" integer,
  "rep_turn_count" integer,
  "rep_question_count" integer,
  "objections" jsonb NOT NULL,
  "competitor_mentions" jsonb NOT NULL,
  "next_step_committed" boolean NOT NULL,
  "next_step" text,
  "model" text,
  "prompt_key" text NOT NULL,
  "prompt_version" integer NOT NULL,
  "transcript_chars" integer NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bank_statement_lines" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "statement_id" text NOT NULL,
  "line_no" integer NOT NULL,
  "value_date" date NOT NULL,
  "amount_minor" bigint NOT NULL,
  "description" text,
  "bank_reference" text,
  "raw_row" jsonb,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bank_statements" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "bank_profile_id" text NOT NULL,
  "source" bank_statement_source DEFAULT 'csv'::bank_statement_source NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "opening_minor" bigint NOT NULL,
  "closing_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "file_hash" text,
  "file_name" text,
  "reconciled_at" timestamp without time zone,
  "reconciled_by" text,
  "imported_by" text,
  "imported_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_call_analysis_refusals" (
  "call_analysis_refusal_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "activity_id" text NOT NULL,
  "jurisdiction" text,
  "reason" text NOT NULL,
  "rule_version" integer NOT NULL,
  "note" text NOT NULL,
  "first_refused_at" timestamp without time zone DEFAULT now() NOT NULL,
  "last_refused_at" timestamp without time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "last_requested_by_user_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_plans" (
  "plan_id" text NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "currency" text DEFAULT 'INR'::text NOT NULL,
  "retired_on" date,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_plan_versions" (
  "plan_version_id" text NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "version_number" integer NOT NULL,
  "effective_from" date NOT NULL,
  "rules" jsonb NOT NULL,
  "sealed_at" timestamp without time zone,
  "note" text,
  "created_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_assignments" (
  "assignment_id" text NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "user_id" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "quota_override_minor" bigint,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_earnings" (
  "earning_id" text NOT NULL,
  "org_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "plan_version_id" text NOT NULL,
  "user_id" text NOT NULL,
  "earned_on" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "basis_minor" bigint NOT NULL,
  "prior_basis_minor" bigint DEFAULT 0 NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "effective_rate_bps" integer DEFAULT 0 NOT NULL,
  "attainment_bps" integer,
  "computation" jsonb,
  "status" text DEFAULT 'CALCULATED'::text NOT NULL,
  "approved_by" text,
  "approved_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_accrual_parts" (
  "part_id" text NOT NULL,
  "org_id" text NOT NULL,
  "earning_id" text NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "plan_version_id" text NOT NULL,
  "earned_on" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "part_index" integer NOT NULL,
  "tier_index" integer NOT NULL,
  "tier_from" bigint NOT NULL,
  "rate_bps" integer NOT NULL,
  "multiplier_bps" integer NOT NULL,
  "slice_from_minor" bigint NOT NULL,
  "slice_to_minor" bigint NOT NULL,
  "basis_minor" bigint NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_commission_accrual_snapshots" (
  "snapshot_id" text NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "as_of_date" date NOT NULL,
  "accrued_minor" bigint NOT NULL,
  "basis_minor" bigint NOT NULL,
  "earning_count" integer DEFAULT 0 NOT NULL,
  "part_count" integer DEFAULT 0 NOT NULL,
  "attainment_bps" integer,
  "currency" text NOT NULL,
  "computed_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_lifecycles" (
  "customer_lifecycle_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "source_deal_id" integer NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "started_on" date NOT NULL,
  "term_months" integer NOT NULL,
  "renewal_on" date NOT NULL,
  "contract_value_minor" bigint DEFAULT 0 NOT NULL,
  "renewal_count" integer DEFAULT 0 NOT NULL,
  "risk_score" integer DEFAULT 0 NOT NULL,
  "risk_computed_at" timestamp without time zone,
  "last_signal_at" timestamp without time zone,
  "closed_reason" text,
  "closed_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_lifecycle_signals" (
  "lifecycle_signal_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "customer_lifecycle_id" text NOT NULL,
  "kind" text NOT NULL,
  "impact" integer NOT NULL,
  "observed_at" timestamp without time zone DEFAULT now() NOT NULL,
  "source" text DEFAULT 'system'::text NOT NULL,
  "recorded_by_user_id" text,
  "note" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_health_assessments" (
  "customer_health_assessment_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "party_id" text NOT NULL,
  "score" integer,
  "health_status" crm_health,
  "coverage_bps" integer NOT NULL,
  "weights_version" integer NOT NULL,
  "computed_at" timestamp without time zone DEFAULT now() NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_health_factors" (
  "customer_health_factor_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "customer_health_assessment_id" text NOT NULL,
  "factor_key" text NOT NULL,
  "weight_bps" integer NOT NULL,
  "effective_weight_bps" integer DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "value" integer,
  "missing_reason" text,
  "contribution_bps" integer DEFAULT 0 NOT NULL,
  "observations" integer DEFAULT 0 NOT NULL,
  "window_days" integer NOT NULL,
  "window_from" timestamp without time zone NOT NULL,
  "window_to" timestamp without time zone NOT NULL,
  "detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_lifecycle_triggers" (
  "customer_lifecycle_trigger_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "customer_lifecycle_id" text NOT NULL,
  "party_id" text NOT NULL,
  "kind" text NOT NULL,
  "term_started_on" date NOT NULL,
  "renewal_on" date NOT NULL,
  "due_on" date NOT NULL,
  "risk_score" integer NOT NULL,
  "health_score" integer,
  "opportunity_deal_id" integer,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamp without time zone,
  "outcome" text,
  "refusal_stage" text,
  "refusal_reason" text,
  "autonomy_hold_id" text,
  "autonomous_decision_id" text,
  "outbound_message_id" text,
  "fired_at" timestamp without time zone DEFAULT now() NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_report_definitions" (
  "report_definition_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "source_key" text NOT NULL,
  "query_description" jsonb NOT NULL,
  "created_by_user_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."crm_report_runs" (
  "report_run_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "report_definition_id" text,
  "source_key" text NOT NULL,
  "compiled_sql" text NOT NULL,
  "parameter_count" integer NOT NULL,
  "row_count" integer,
  "duration_ms" integer,
  "ran_by_user_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."gl_book_currencies" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "currency_code" text NOT NULL,
  "is_base" boolean DEFAULT false NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."cell_capacity_measurements" (
  "measurement_id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "cell_id" text NOT NULL,
  "limiting_resource" text NOT NULL,
  "used" double precision NOT NULL,
  "limit_value" double precision NOT NULL,
  "per_org_cost" double precision NOT NULL,
  "ceiling_source" cell_ceiling_source NOT NULL,
  "measured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
--
-- columns on tables that already exist (76)
--
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD COLUMN IF NOT EXISTS "crm_contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "build"."feedback_posts" ADD COLUMN IF NOT EXISTS "crm_organization_party_id" text;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD COLUMN IF NOT EXISTS "crm_contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "build"."feedbucket_submissions" ADD COLUMN IF NOT EXISTS "crm_organization_party_id" text;
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "customer_party_id" text;
--> statement-breakpoint
ALTER TABLE "build"."tickets" ADD COLUMN IF NOT EXISTS "customer_org_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."autonomy_holds" ADD COLUMN IF NOT EXISTS "outbound_message_id" text;
--> statement-breakpoint
ALTER TABLE "public"."calendar_events" ADD COLUMN IF NOT EXISTS "linked_lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."client_accounts" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."client_onboarding_items" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."client_opportunities" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_channel_consent" ADD COLUMN IF NOT EXISTS "contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_consent_events" ADD COLUMN IF NOT EXISTS "contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."crm_contact_roles" ADD COLUMN IF NOT EXISTS "contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_stakeholders" ADD COLUMN IF NOT EXISTS "contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."crm_lead_touchpoints" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."csat_surveys" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "key" text;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND a.attname = 'key' AND a.attnotnull) THEN
    ALTER TABLE "public"."custom_field_definitions" ALTER COLUMN "key" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "display_order" integer DEFAULT 0;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND a.attname = 'display_order' AND a.attnotnull) THEN
    ALTER TABLE "public"."custom_field_definitions" ALTER COLUMN "display_order" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "project_id" integer DEFAULT 0;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND a.attname = 'project_id' AND a.attnotnull) THEN
    ALTER TABLE "public"."custom_field_definitions" ALTER COLUMN "project_id" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "settings" jsonb;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "is_sensitive" boolean DEFAULT false;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND a.attname = 'is_sensitive' AND a.attnotnull) THEN
    ALTER TABLE "public"."custom_field_definitions" ALTER COLUMN "is_sensitive" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "public"."deals" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD COLUMN IF NOT EXISTS "posted_journal_id" text;
--> statement-breakpoint
ALTER TABLE "public"."fin_reimbursement_batches" ADD COLUMN IF NOT EXISTS "cash_account_id" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_customer_returns" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_grn_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18,6);
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "checksum" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "chunk_size" integer DEFAULT 500;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND a.attname = 'chunk_size' AND a.attnotnull) THEN
    ALTER TABLE "public"."inv_import_jobs" ALTER COLUMN "chunk_size" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "next_row" integer DEFAULT 0;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND a.attname = 'next_row' AND a.attnotnull) THEN
    ALTER TABLE "public"."inv_import_jobs" ALTER COLUMN "next_row" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "staged_rows" integer DEFAULT 0;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND a.attname = 'staged_rows' AND a.attnotnull) THEN
    ALTER TABLE "public"."inv_import_jobs" ALTER COLUMN "staged_rows" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "started_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_jobs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_po_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18,6);
--> statement-breakpoint
ALTER TABLE "public"."inv_product_variants" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_products" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."inv_sales_orders" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."inv_so_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18,6);
--> statement-breakpoint
ALTER TABLE "public"."inv_stock_adjustment_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18,6);
--> statement-breakpoint
ALTER TABLE "public"."inv_stock_transactions" ADD COLUMN IF NOT EXISTS "quantity_bucket" inv_quantity_bucket DEFAULT 'ON_HAND'::inv_quantity_bucket;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND a.attname = 'quantity_bucket' AND a.attnotnull) THEN
    ALTER TABLE "public"."inv_stock_transactions" ALTER COLUMN "quantity_bucket" SET NOT NULL;
  END IF;
END $repair$;
--> statement-breakpoint
ALTER TABLE "public"."inv_stock_transfer_lines" ADD COLUMN IF NOT EXISTS "uom_factor" numeric(18,6);
--> statement-breakpoint
ALTER TABLE "public"."inv_vendors" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."lead_activities" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."lead_emails" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."lead_notes" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."lead_tasks" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_payments" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_payments" ADD COLUMN IF NOT EXISTS "provider_payment_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_payments" ADD COLUMN IF NOT EXISTS "provider_order_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_payments" ADD COLUMN IF NOT EXISTS "provider_signature" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "token_hash" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "admitted_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "admitted_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp without time zone;
--> statement-breakpoint
ALTER TABLE "public"."platform_waitlist" ADD COLUMN IF NOT EXISTS "claimed_org_id" text;
--> statement-breakpoint
ALTER TABLE "public"."purchase_bills" ADD COLUMN IF NOT EXISTS "vendor_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."subscription_payments" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "public"."subscription_payments" ADD COLUMN IF NOT EXISTS "provider_payment_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."subscription_payments" ADD COLUMN IF NOT EXISTS "provider_order_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "provider_subscription_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "provider_customer_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "provider_plan_ref" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "agreed_price_minor" integer;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "agreed_currency" text;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD COLUMN IF NOT EXISTS "price_effective_from" text;
--> statement-breakpoint
ALTER TABLE "public"."support_tickets" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."support_vip_clients" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" ADD COLUMN IF NOT EXISTS "lead_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."survey_participants" ADD COLUMN IF NOT EXISTS "contact_party_id" text;
--> statement-breakpoint
ALTER TABLE "public"."timesheet_rates" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
--
-- columns a migration renamed or dropped, which a cold build never reaches (3)
--
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" DROP COLUMN IF EXISTS "name";
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" DROP COLUMN IF EXISTS "sort_order";
--> statement-breakpoint
ALTER TABLE "public"."custom_field_definitions" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
--
-- functions (5)
--
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.derive_party_from_legacy()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  legacy_col text := TG_ARGV[0];
  party_col  text := TG_ARGV[1];
  org_col    text := TG_ARGV[2];
  map_table  text := TG_ARGV[3];
  map_col    text := TG_ARGV[4];
  row_json   jsonb := to_jsonb(NEW);
  resolved   text;
BEGIN
  IF row_json ->> party_col IS NOT NULL THEN RETURN NEW; END IF;
  IF row_json ->> legacy_col IS NULL THEN RETURN NEW; END IF;

  EXECUTE format(
    'SELECT party_id FROM %I WHERE %I = $1 AND organization_id = $2',
    map_table, map_col
  )
  INTO resolved
  USING (row_json ->> legacy_col)::int, row_json ->> org_col;

  IF resolved IS NULL THEN RETURN NEW; END IF;

  RETURN jsonb_populate_record(NEW, jsonb_build_object(party_col, resolved));
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.search_inventory_variant_ids(p_q text, p_limit integer)
 RETURNS SETOF integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
  SELECT v.id
  FROM public.inv_product_variants v
  JOIN public.inv_products p ON p.id = v.product_id
  WHERE p.org_id = app.current_org_id()
    AND v.org_id = app.current_org_id()
    AND p.deleted_at IS NULL
    AND v.deleted_at IS NULL
    AND (p.name ILIKE '%' || p_q || '%'
      OR p.sku ILIKE '%' || p_q || '%'
      OR v.sku ILIKE '%' || p_q || '%'
      OR v.barcode ILIKE '%' || p_q || '%')
  LIMIT p_limit
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.crm_commission_plan_version_seal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."sealed_at" IS NOT NULL THEN
      RAISE EXCEPTION
        'commission plan version % has been earned against and cannot be deleted',
        OLD."plan_version_id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."rules" IS DISTINCT FROM OLD."rules"
    OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."plan_id" IS DISTINCT FROM OLD."plan_id"
    OR NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
  ) THEN
    RAISE EXCEPTION
      'commission plan version % has been earned against; publish a new version instead of restating this one',
      OLD."plan_version_id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.crm_commission_seal_version_on_earning()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "crm_commission_plan_versions"
     SET "sealed_at" = now()
   WHERE "plan_version_id" = NEW."plan_version_id"
     AND "org_id" = NEW."org_id"
     AND "sealed_at" IS NULL;
  RETURN NULL;
END;
$function$
;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.crm_commission_accrual_parts_reconcile()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_org text;
  target_earning text;
  parts_total bigint;
  earning_total bigint;
  parts_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_org := OLD."org_id";
    target_earning := OLD."earning_id";
  ELSE
    target_org := NEW."org_id";
    target_earning := NEW."earning_id";
  END IF;

  SELECT coalesce(sum(p."amount_minor"), 0), count(*)
    INTO parts_total, parts_count
    FROM "crm_commission_accrual_parts" p
   WHERE p."org_id" = target_org
     AND p."earning_id" = target_earning;

  -- Nothing left to reconcile: a rebuild that removed a decomposition, or an
  -- earning that has not been decomposed yet.
  IF parts_count = 0 THEN
    RETURN NULL;
  END IF;

  SELECT e."amount_minor"
    INTO earning_total
    FROM "crm_commission_earnings" e
   WHERE e."org_id" = target_org
     AND e."earning_id" = target_earning;

  -- The earning went away in this same transaction; the FK cascade is removing
  -- these rows too and there is nothing to check against.
  IF earning_total IS NULL THEN
    RETURN NULL;
  END IF;

  IF parts_total <> earning_total THEN
    RAISE EXCEPTION
      'commission accrual parts for earning % sum to % but the earning is %; a decomposition must reconstruct its total exactly',
      target_earning, parts_total, earning_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$function$
;
--> statement-breakpoint
--
-- primary keys, unique and check constraints (262)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'pk_crm_org_party_map') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "pk_crm_org_party_map" PRIMARY KEY (organization_id, crm_organization_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_pkey') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_pkey" PRIMARY KEY (relationship_state_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'chk_relationship_states_one_anchor') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "chk_relationship_states_one_anchor" CHECK ((((party_id IS NOT NULL) AND (deal_id IS NULL)) OR ((party_id IS NULL) AND (deal_id IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'chk_relationship_states_latency') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "chk_relationship_states_latency" CHECK ((((reply_sample_count = 0) AND (reply_p50_seconds IS NULL) AND (reply_p90_seconds IS NULL) AND (reply_min_seconds IS NULL) AND (reply_max_seconds IS NULL)) OR ((reply_sample_count > 0) AND (reply_p50_seconds IS NOT NULL) AND (reply_p90_seconds IS NOT NULL) AND (reply_min_seconds IS NOT NULL) AND (reply_max_seconds IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'chk_relationship_states_counts') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "chk_relationship_states_counts" CHECK (((contact_count >= 0) AND (inbound_count >= 0) AND (outbound_count >= 0) AND (unreadable_direction_count >= 0) AND (reply_sample_count >= 0) AND (participant_count >= 0) AND (thread_count >= 0) AND ((reply_p50_seconds IS NULL) OR (reply_p50_seconds >= 0)) AND ((reply_p90_seconds IS NULL) OR (reply_p90_seconds >= 0)) AND ((reply_min_seconds IS NULL) OR (reply_min_seconds >= 0)) AND ((reply_max_seconds IS NULL) OR (reply_max_seconds >= 0))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'chk_relationship_participants_identity') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "chk_relationship_participants_identity" CHECK (((party_id IS NOT NULL) OR (user_id IS NOT NULL) OR (address IS NOT NULL)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'chk_relationship_participants_counts') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "chk_relationship_participants_counts" CHECK (((message_count >= 0) AND (replied_count >= 0) AND (replied_count <= message_count)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'chk_relationship_threads_direction') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "chk_relationship_threads_direction" CHECK (((last_direction IS NULL) OR (last_direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'chk_relationship_threads_counts') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "chk_relationship_threads_counts" CHECK (((message_count >= 0) AND ((preceded_by_thread_id IS NULL) OR (preceded_by_thread_id <> thread_id))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_pkey') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_pkey" PRIMARY KEY (relationship_participant_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'uniq_relationship_states_org_id') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "uniq_relationship_states_org_id" UNIQUE (organization_id, relationship_state_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_pkey') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_pkey" PRIMARY KEY (relationship_thread_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND k.conname = 'chk_inv_stock_transactions_arithmetic') THEN
    ALTER TABLE "public"."inv_stock_transactions" ADD CONSTRAINT "chk_inv_stock_transactions_arithmetic" CHECK ((quantity_after = (quantity_before + quantity_change)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND k.conname = 'chk_inv_stock_transactions_nonzero') THEN
    ALTER TABLE "public"."inv_stock_transactions" ADD CONSTRAINT "chk_inv_stock_transactions_nonzero" CHECK ((quantity_change <> (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_levels' AND k.conname = 'chk_inv_stock_levels_buckets_non_negative') THEN
    ALTER TABLE "public"."inv_stock_levels" ADD CONSTRAINT "chk_inv_stock_levels_buckets_non_negative" CHECK (((committed >= (0)::numeric) AND (COALESCE(blocked_qty, (0)::numeric) >= (0)::numeric) AND (COALESCE(quality_hold_qty, (0)::numeric) >= (0)::numeric) AND (COALESCE(outgoing_qty, (0)::numeric) >= (0)::numeric) AND (COALESCE(on_order, (0)::numeric) >= (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transfers' AND k.conname = 'chk_inv_stock_transfers_distinct_endpoints') THEN
    ALTER TABLE "public"."inv_stock_transfers" ADD CONSTRAINT "chk_inv_stock_transfers_distinct_endpoints" CHECK ((from_location_id IS DISTINCT FROM to_location_id));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transfer_lines' AND k.conname = 'chk_inv_stock_transfer_lines_quantities') THEN
    ALTER TABLE "public"."inv_stock_transfer_lines" ADD CONSTRAINT "chk_inv_stock_transfer_lines_quantities" CHECK ((quantity > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_po_lines' AND k.conname = 'chk_inv_po_lines_quantities') THEN
    ALTER TABLE "public"."inv_po_lines" ADD CONSTRAINT "chk_inv_po_lines_quantities" CHECK (((quantity > (0)::numeric) AND (quantity_received >= (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_so_lines' AND k.conname = 'chk_inv_so_lines_quantities') THEN
    ALTER TABLE "public"."inv_so_lines" ADD CONSTRAINT "chk_inv_so_lines_quantities" CHECK ((quantity > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_lines' AND k.conname = 'chk_inv_grn_lines_quantities') THEN
    ALTER TABLE "public"."inv_grn_lines" ADD CONSTRAINT "chk_inv_grn_lines_quantities" CHECK ((quantity_received > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_lots' AND k.conname = 'chk_inv_lots_expiry_after_manufacture') THEN
    ALTER TABLE "public"."inv_lots" ADD CONSTRAINT "chk_inv_lots_expiry_after_manufacture" CHECK (((expiry_date IS NULL) OR (manufacture_date IS NULL) OR (expiry_date >= manufacture_date)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_pkey') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_pkey" PRIMARY KEY (subprocessor_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessor_subscribers' AND k.conname = 'subprocessor_subscribers_pkey') THEN
    ALTER TABLE "public"."subprocessor_subscribers" ADD CONSTRAINT "subprocessor_subscribers_pkey" PRIMARY KEY (subprocessor_subscriber_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_pkey') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_pkey" PRIMARY KEY (subject_request_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_pkey') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_pkey" PRIMARY KEY (crm_deal_forecast_model_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'chk_crm_deal_forecast_models_status') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_status" CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'chk_crm_deal_forecast_models_counts') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_counts" CHECK (((training_deals > 0) AND (holdout_deals >= 0) AND (won_deals >= 0) AND (lost_deals >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'chk_crm_deal_forecast_models_ridge') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "chk_crm_deal_forecast_models_ridge" CHECK ((ridge > (0)::double precision));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'uniq_crm_deal_forecast_models_org_id') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "uniq_crm_deal_forecast_models_org_id" UNIQUE (organization_id, crm_deal_forecast_model_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_pkey') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_pkey" PRIMARY KEY (crm_deal_forecast_score_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'chk_crm_deal_forecast_scores_probability') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_probability" CHECK (((probability >= (0)::double precision) AND (probability <= (1)::double precision)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'chk_crm_deal_forecast_scores_interval') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_interval" CHECK (((interval_lower >= (0)::double precision) AND (interval_upper <= (1)::double precision) AND (interval_lower <= probability) AND (probability <= interval_upper)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'chk_crm_deal_forecast_scores_value') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "chk_crm_deal_forecast_scores_value" CHECK ((expected_value_minor >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'uniq_crm_deal_forecast_scores_org_id') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "uniq_crm_deal_forecast_scores_org_id" UNIQUE (organization_id, crm_deal_forecast_score_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_pkey') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_pkey" PRIMARY KEY (autonomy_repair_policy_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_pkey') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_pkey" PRIMARY KEY (autonomy_repair_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'uniq_autonomy_repairs_org_id') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "uniq_autonomy_repairs_org_id" UNIQUE (organization_id, autonomy_repair_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_pkey') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_pkey" PRIMARY KEY (outbound_message_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_status') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_status" CHECK ((status = ANY (ARRAY['drafted'::text, 'held'::text, 'sent'::text, 'cancelled'::text, 'blocked'::text, 'failed'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_class') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_class" CHECK ((outbound_class = ANY (ARRAY['follow_up'::text, 'nudge'::text, 'check_in'::text, 'meeting_request'::text, 'cold_outreach'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_track') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_track" CHECK ((((outbound_class = 'cold_outreach'::text) AND (track = 'cold'::text)) OR ((outbound_class <> 'cold_outreach'::text) AND (track = 'engaged'::text))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'ck_gl_books_fy_month') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "ck_gl_books_fy_month" CHECK (((fiscal_year_start_month >= 1) AND (fiscal_year_start_month <= 12)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'ck_gl_books_fy_day') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "ck_gl_books_fy_day" CHECK (((fiscal_year_start_day >= 1) AND (fiscal_year_start_day <= 28)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'ck_gl_books_base_currency') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "ck_gl_books_base_currency" CHECK ((base_currency ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_pkey') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'uniq_gl_books_org_id') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "uniq_gl_books_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'ck_gl_currencies_code') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "ck_gl_currencies_code" CHECK ((code ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'ck_gl_currencies_minor_units') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "ck_gl_currencies_minor_units" CHECK (((minor_units >= 0) AND (minor_units <= 4)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'gl_currencies_pkey') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "gl_currencies_pkey" PRIMARY KEY (code);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_pkey') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'uniq_gl_book_currencies_org_id') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "uniq_gl_book_currencies_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'ck_gl_fx_rates_positive') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "ck_gl_fx_rates_positive" CHECK ((rate > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'ck_gl_fx_rates_distinct') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "ck_gl_fx_rates_distinct" CHECK ((from_code <> to_code));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_pkey') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'uniq_gl_fx_rates_org_id') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "uniq_gl_fx_rates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'ck_gl_accounts_header_not_cash') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "ck_gl_accounts_header_not_cash" CHECK ((NOT (is_header AND is_cash)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_pkey') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'uniq_gl_accounts_org_id') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "uniq_gl_accounts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'uniq_gl_accounts_book_id') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "uniq_gl_accounts_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'ck_gl_fiscal_years_range') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "ck_gl_fiscal_years_range" CHECK ((ends_on > starts_on));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_pkey') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'uniq_gl_fiscal_years_org_id') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "uniq_gl_fiscal_years_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'uniq_gl_fiscal_years_book_id') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "uniq_gl_fiscal_years_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'ck_gl_periods_range') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "ck_gl_periods_range" CHECK ((ends_on >= starts_on));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_tz_source') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_tz_source" CHECK (((timezone_source IS NULL) OR (timezone_source = ANY (ARRAY['party'::text, 'tenant'::text]))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_sent') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_sent" CHECK ((((status = 'sent'::text) AND (sent_at IS NOT NULL) AND (recipient_email IS NOT NULL)) OR ((status <> 'sent'::text) AND (sent_at IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'chk_crm_outbound_messages_deferrals') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "chk_crm_outbound_messages_deferrals" CHECK ((working_hour_deferrals >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'uniq_crm_outbound_messages_org_id') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "uniq_crm_outbound_messages_org_id" UNIQUE (organization_id, outbound_message_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_pkey') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_pkey" PRIMARY KEY (outbound_class_stop_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'chk_crm_outbound_class_stops_class') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "chk_crm_outbound_class_stops_class" CHECK ((outbound_class = ANY (ARRAY['follow_up'::text, 'nudge'::text, 'check_in'::text, 'meeting_request'::text, 'cold_outreach'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'crm_cold_outbound_settings_pkey') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "crm_cold_outbound_settings_pkey" PRIMARY KEY (organization_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'chk_crm_cold_outbound_settings_pause') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "chk_crm_cold_outbound_settings_pause" CHECK ((((paused_at IS NULL) AND (pause_reason IS NULL)) OR ((paused_at IS NOT NULL) AND (pause_reason IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_pkey') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_pkey" PRIMARY KEY (sending_domain_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'chk_crm_sending_domains_purpose') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "chk_crm_sending_domains_purpose" CHECK ((purpose = ANY (ARRAY['transactional'::text, 'cold'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_pkey') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'uniq_gl_periods_org_id') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "uniq_gl_periods_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'uniq_gl_periods_book_id') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "uniq_gl_periods_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_pkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'uniq_gl_journals_org_id') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "uniq_gl_journals_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'uniq_gl_journals_book_id') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "uniq_gl_journals_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_one_side') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_one_side" CHECK (((debit_minor = 0) <> (credit_minor = 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_non_negative') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_non_negative" CHECK (((debit_minor >= 0) AND (credit_minor >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_txn_positive') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_txn_positive" CHECK ((txn_amount_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_functional_positive') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_functional_positive" CHECK ((functional_amount_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_functional_matches_side') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_functional_matches_side" CHECK ((functional_amount_minor = GREATEST(debit_minor, credit_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_fx_positive') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_fx_positive" CHECK ((fx_rate > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'ck_gl_journal_lines_same_ccy_rate_one') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "ck_gl_journal_lines_same_ccy_rate_one" CHECK (((txn_currency <> functional_currency) OR (fx_rate = (1)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_pkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'uniq_gl_journal_lines_org_id') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "uniq_gl_journal_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'ck_gl_document_sequences_next') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "ck_gl_document_sequences_next" CHECK ((next_number >= 1));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'ck_gl_document_sequences_padding') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "ck_gl_document_sequences_padding" CHECK (((padding >= 1) AND (padding <= 12)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_pkey') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'uniq_gl_document_sequences_org_id') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "uniq_gl_document_sequences_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_pkey') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'uniq_tax_codes_org_id') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "uniq_tax_codes_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'uniq_tax_codes_book_id') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "uniq_tax_codes_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'ck_tax_rates_bp') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "ck_tax_rates_bp" CHECK (((rate_bp >= 0) AND (rate_bp <= 100000)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'ck_tax_rates_window') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "ck_tax_rates_window" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_pkey') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'uniq_tax_rates_org_id') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "uniq_tax_rates_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'ck_tax_registrations_owner_arc') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "ck_tax_registrations_owner_arc" CHECK ((((owner_type = 'book'::tax_registration_owner) AND (book_id IS NOT NULL) AND (party_id IS NULL)) OR ((owner_type = 'party'::tax_registration_owner) AND (party_id IS NOT NULL) AND (book_id IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_pkey') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'uniq_tax_registrations_org_id') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "uniq_tax_registrations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_pkey') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'uniq_tax_gl_map_org_id') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "uniq_tax_gl_map_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'ck_tax_document_lines_taxable') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "ck_tax_document_lines_taxable" CHECK ((taxable_minor >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_pkey') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'uniq_tax_document_lines_org_id') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "uniq_tax_document_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'ck_gl_parties_currency') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "ck_gl_parties_currency" CHECK ((default_currency ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'ck_gl_parties_terms') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "ck_gl_parties_terms" CHECK ((payment_terms_days >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_pkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'uniq_gl_parties_org_id') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "uniq_gl_parties_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'uniq_gl_parties_book_id') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "uniq_gl_parties_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ck_ar_documents_amounts') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ck_ar_documents_amounts" CHECK (((net_minor >= 0) AND (tax_minor >= 0) AND (gross_minor >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ck_ar_documents_settled') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ck_ar_documents_settled" CHECK (((settled_minor >= 0) AND (settled_minor <= gross_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ck_ar_documents_currency') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ck_ar_documents_currency" CHECK ((currency ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ck_ar_documents_fx') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ck_ar_documents_fx" CHECK ((fx_rate > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ck_ar_documents_posted_complete') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ck_ar_documents_posted_complete" CHECK (((status = 'DRAFT'::acct_document_status) OR ((document_number IS NOT NULL) AND (posted_journal_id IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_pkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'uniq_ar_documents_org_id') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "uniq_ar_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'uniq_ar_documents_book_id') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "uniq_ar_documents_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ck_ar_document_lines_quantity') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ck_ar_document_lines_quantity" CHECK ((quantity_milli <> 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ck_ar_document_lines_discount') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ck_ar_document_lines_discount" CHECK ((discount_minor >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_pkey') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'uniq_ar_document_lines_org_id') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "uniq_ar_document_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ck_ar_receipts_amount') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ck_ar_receipts_amount" CHECK ((amount_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ck_ar_receipts_unapplied') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ck_ar_receipts_unapplied" CHECK (((unapplied_minor >= 0) AND (unapplied_minor <= amount_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_pkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'uniq_ar_receipts_org_id') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "uniq_ar_receipts_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'uniq_ar_receipts_book_id') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "uniq_ar_receipts_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ck_ar_allocations_amount') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ck_ar_allocations_amount" CHECK ((amount_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ck_ar_allocations_source_arc') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ck_ar_allocations_source_arc" CHECK ((((receipt_id IS NOT NULL) AND (credit_note_id IS NULL)) OR ((receipt_id IS NULL) AND (credit_note_id IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_pkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'uniq_ar_allocations_org_id') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "uniq_ar_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ck_ap_documents_amounts') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ck_ap_documents_amounts" CHECK (((net_minor >= 0) AND (tax_minor >= 0) AND (gross_minor >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ck_ap_documents_settled') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ck_ap_documents_settled" CHECK (((settled_minor >= 0) AND (settled_minor <= gross_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ck_ap_documents_currency') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ck_ap_documents_currency" CHECK ((currency ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ck_ap_documents_fx') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ck_ap_documents_fx" CHECK ((fx_rate > (0)::numeric));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ck_ap_documents_posted_complete') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ck_ap_documents_posted_complete" CHECK (((status = 'DRAFT'::acct_document_status) OR ((document_number IS NOT NULL) AND (posted_journal_id IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_pkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'uniq_ap_documents_org_id') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "uniq_ap_documents_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'uniq_ap_documents_book_id') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "uniq_ap_documents_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ck_ap_document_lines_quantity') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ck_ap_document_lines_quantity" CHECK ((quantity_milli <> 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ck_ap_document_lines_discount') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ck_ap_document_lines_discount" CHECK ((discount_minor >= 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_pkey') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'uniq_ap_document_lines_org_id') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "uniq_ap_document_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ck_ap_payments_gross') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ck_ap_payments_gross" CHECK ((gross_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ck_ap_payments_withheld') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ck_ap_payments_withheld" CHECK (((withheld_minor >= 0) AND (withheld_minor <= gross_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ck_ap_payments_net') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ck_ap_payments_net" CHECK ((net_paid_minor = (gross_minor - withheld_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_pkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'uniq_ap_payments_org_id') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "uniq_ap_payments_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'uniq_ap_payments_book_id') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "uniq_ap_payments_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ck_ap_allocations_amount') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ck_ap_allocations_amount" CHECK ((amount_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ck_ap_allocations_source_arc') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ck_ap_allocations_source_arc" CHECK ((((payment_id IS NOT NULL) AND (debit_note_id IS NULL)) OR ((payment_id IS NULL) AND (debit_note_id IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_pkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'uniq_ap_allocations_org_id') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "uniq_ap_allocations_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ck_ap_withholding_base') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ck_ap_withholding_base" CHECK ((base_minor > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ck_ap_withholding_amount') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ck_ap_withholding_amount" CHECK (((withheld_minor >= 0) AND (withheld_minor <= base_minor)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ck_ap_withholding_rate') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ck_ap_withholding_rate" CHECK (((rate_bp >= 0) AND (rate_bp <= 10000)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_pkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'uniq_ap_withholding_org_id') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "uniq_ap_withholding_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'ck_bank_profiles_currency') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "ck_bank_profiles_currency" CHECK ((currency ~ '^[A-Z]{3}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_pkey') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'uniq_bank_profiles_org_id') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "uniq_bank_profiles_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'ck_bank_statements_period') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "ck_bank_statements_period" CHECK ((period_end >= period_start));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_pkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'uniq_bank_statements_org_id') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "uniq_bank_statements_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'ck_bank_statement_lines_amount') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "ck_bank_statement_lines_amount" CHECK ((amount_minor <> 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_pkey') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'uniq_bank_statement_lines_org_id') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "uniq_bank_statement_lines_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'ck_bank_matches_counterpart_arc') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "ck_bank_matches_counterpart_arc" CHECK ((((kind = 'receipt'::bank_match_kind) AND (receipt_id IS NOT NULL) AND (payment_id IS NULL) AND (journal_id IS NULL)) OR ((kind = 'payment'::bank_match_kind) AND (payment_id IS NOT NULL) AND (receipt_id IS NULL) AND (journal_id IS NULL)) OR ((kind = 'journal'::bank_match_kind) AND (journal_id IS NOT NULL) AND (receipt_id IS NULL) AND (payment_id IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_pkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'uniq_bank_matches_org_id') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "uniq_bank_matches_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_pkey') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'uniq_gl_document_compliance_org_id') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "uniq_gl_document_compliance_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_holds' AND k.conname = 'chk_autonomy_holds_arc') THEN
    ALTER TABLE "public"."autonomy_holds" ADD CONSTRAINT "chk_autonomy_holds_arc" CHECK ((num_nonnulls(quote_id, outbound_message_id) = 1));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subscriptions' AND k.conname = 'chk_subscriptions_agreed_price') THEN
    ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "chk_subscriptions_agreed_price" CHECK (((agreed_price_minor IS NULL) OR (agreed_price_minor >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subscriptions' AND k.conname = 'chk_subscriptions_agreed_price_complete') THEN
    ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "chk_subscriptions_agreed_price_complete" CHECK ((((agreed_price_minor IS NULL) AND (agreed_currency IS NULL) AND (price_effective_from IS NULL)) OR ((agreed_price_minor IS NOT NULL) AND (agreed_currency IS NOT NULL) AND (price_effective_from IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_po_lines' AND k.conname = 'chk_inv_po_lines_uom_factor') THEN
    ALTER TABLE "public"."inv_po_lines" ADD CONSTRAINT "chk_inv_po_lines_uom_factor" CHECK (((uom_factor IS NULL) OR (uom_factor > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_so_lines' AND k.conname = 'chk_inv_so_lines_uom_factor') THEN
    ALTER TABLE "public"."inv_so_lines" ADD CONSTRAINT "chk_inv_so_lines_uom_factor" CHECK (((uom_factor IS NULL) OR (uom_factor > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_grn_lines' AND k.conname = 'chk_inv_grn_lines_uom_factor') THEN
    ALTER TABLE "public"."inv_grn_lines" ADD CONSTRAINT "chk_inv_grn_lines_uom_factor" CHECK (((uom_factor IS NULL) OR (uom_factor > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_adjustment_lines' AND k.conname = 'chk_inv_stock_adjustment_lines_uom_factor') THEN
    ALTER TABLE "public"."inv_stock_adjustment_lines" ADD CONSTRAINT "chk_inv_stock_adjustment_lines_uom_factor" CHECK (((uom_factor IS NULL) OR (uom_factor > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transfer_lines' AND k.conname = 'chk_inv_stock_transfer_lines_uom_factor') THEN
    ALTER TABLE "public"."inv_stock_transfer_lines" ADD CONSTRAINT "chk_inv_stock_transfer_lines_uom_factor" CHECK (((uom_factor IS NULL) OR (uom_factor > (0)::numeric)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_pkey') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'uniq_inv_import_rows_org_id') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "uniq_inv_import_rows_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'ck_gl_document_attachments_type') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "ck_gl_document_attachments_type" CHECK ((document_type = ANY (ARRAY['sales_invoice'::text, 'credit_note'::text, 'purchase_bill'::text, 'debit_note'::text, 'receipt'::text, 'payment'::text, 'journal'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'ck_gl_document_attachments_size') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "ck_gl_document_attachments_size" CHECK ((size_bytes > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_pkey') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_pkey" PRIMARY KEY (id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'uniq_gl_document_attachments_org_id') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "uniq_gl_document_attachments_org_id" UNIQUE (org_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'uniq_gl_document_attachments_book_id') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "uniq_gl_document_attachments_book_id" UNIQUE (book_id, id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_pkey') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_pkey" PRIMARY KEY (call_analysis_release_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_pkey') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_pkey" PRIMARY KEY (call_analysis_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_hash') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_hash" CHECK ((transcript_hash ~ '^[0-9a-f]{64}$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_talk_ratio') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_talk_ratio" CHECK (((talk_ratio_bps IS NULL) OR ((talk_ratio_bps >= 0) AND (talk_ratio_bps <= 10000))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_metrics_arc') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_metrics_arc" CHECK ((num_nonnulls(talk_ratio_bps, rep_turn_count, rep_question_count) = ANY (ARRAY[0, 3])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_counts') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_counts" CHECK ((((rep_turn_count IS NULL) AND (rep_question_count IS NULL)) OR ((rep_turn_count >= 0) AND (rep_question_count >= 0))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_next_step') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_next_step" CHECK ((((next_step_committed = true) AND (next_step IS NOT NULL)) OR ((next_step_committed = false) AND (next_step IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_transcript_chars') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_transcript_chars" CHECK ((transcript_chars > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'chk_crm_call_analyses_json_arrays') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "chk_crm_call_analyses_json_arrays" CHECK (((jsonb_typeof(objections) = 'array'::text) AND (jsonb_typeof(competitor_mentions) = 'array'::text)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'chk_crm_call_analysis_releases_note') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "chk_crm_call_analysis_releases_note" CHECK (((note IS NULL) OR (char_length(note) <= 500)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'chk_crm_call_analysis_releases_version') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "chk_crm_call_analysis_releases_version" CHECK ((analyzer_version > 0));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_pkey') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_pkey" PRIMARY KEY (call_recording_consent_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'chk_crm_call_recording_consent_jurisdiction') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_jurisdiction" CHECK ((jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'chk_crm_call_recording_consent_note') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_note" CHECK (((note IS NULL) OR (char_length(note) <= 500)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'chk_crm_call_recording_consent_org_pair') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_org_pair" CHECK (((org_party_consented_at IS NULL) = (org_party_method IS NULL)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'chk_crm_call_recording_consent_other_pair') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "chk_crm_call_recording_consent_other_pair" CHECK (((counterparty_consented_at IS NULL) = (counterparty_method IS NULL)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_pkey') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_pkey" PRIMARY KEY (call_analysis_refusal_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'chk_crm_call_analysis_refusals_attempts') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "chk_crm_call_analysis_refusals_attempts" CHECK ((attempts >= 1));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_pkey') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_pkey" PRIMARY KEY (plan_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'chk_crm_commission_plan_versions_rules_object') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "chk_crm_commission_plan_versions_rules_object" CHECK ((jsonb_typeof(rules) = 'object'::text));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'chk_crm_commission_plan_versions_rules_tiers') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "chk_crm_commission_plan_versions_rules_tiers" CHECK (((jsonb_typeof((rules -> 'tiers'::text)) = 'array'::text) AND (jsonb_array_length((rules -> 'tiers'::text)) >= 1)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'chk_crm_commission_plan_versions_number') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "chk_crm_commission_plan_versions_number" CHECK ((version_number >= 1));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_pkey') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_pkey" PRIMARY KEY (plan_version_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'chk_crm_commission_assignments_dates') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "chk_crm_commission_assignments_dates" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'chk_crm_commission_assignments_quota') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "chk_crm_commission_assignments_quota" CHECK (((quota_override_minor IS NULL) OR (quota_override_minor > 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_pkey') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_pkey" PRIMARY KEY (assignment_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'chk_crm_commission_earnings_status') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "chk_crm_commission_earnings_status" CHECK ((status = ANY (ARRAY['CALCULATED'::text, 'APPROVED'::text, 'PAID'::text, 'VOID'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'chk_crm_commission_earnings_period') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "chk_crm_commission_earnings_period" CHECK ((period_end >= period_start));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'chk_crm_commission_earnings_earned_in_period') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "chk_crm_commission_earnings_earned_in_period" CHECK (((earned_on >= period_start) AND (earned_on <= period_end)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_pkey') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_pkey" PRIMARY KEY (earning_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'chk_crm_commission_accrual_parts_index') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "chk_crm_commission_accrual_parts_index" CHECK (((part_index >= 0) AND (tier_index >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'chk_crm_commission_accrual_parts_rate') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "chk_crm_commission_accrual_parts_rate" CHECK (((rate_bps >= 0) AND (multiplier_bps > 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'chk_crm_commission_accrual_parts_slice') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "chk_crm_commission_accrual_parts_slice" CHECK (((slice_to_minor >= slice_from_minor) AND (basis_minor = (slice_to_minor - slice_from_minor))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'chk_crm_commission_accrual_parts_period') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "chk_crm_commission_accrual_parts_period" CHECK (((period_end >= period_start) AND ((earned_on >= period_start) AND (earned_on <= period_end))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_pkey') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_pkey" PRIMARY KEY (part_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'chk_crm_commission_accrual_snapshots_period') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "chk_crm_commission_accrual_snapshots_period" CHECK (((period_end >= period_start) AND ((as_of_date >= period_start) AND (as_of_date <= period_end))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'chk_crm_commission_accrual_snapshots_counts') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "chk_crm_commission_accrual_snapshots_counts" CHECK (((earning_count >= 0) AND (part_count >= 0)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_pkey') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_pkey" PRIMARY KEY (snapshot_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_pkey') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_pkey" PRIMARY KEY (customer_lifecycle_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'chk_customer_lifecycles_status') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_status" CHECK ((status = ANY (ARRAY['active'::text, 'churned'::text, 'cancelled'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'chk_customer_lifecycles_term') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_term" CHECK (((term_months >= 1) AND (term_months <= 120)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'chk_customer_lifecycles_dates') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_dates" CHECK ((renewal_on > started_on));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'chk_customer_lifecycle_signals_impact') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_impact" CHECK (((impact >= '-100'::integer) AND (impact <= 100)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'chk_customer_lifecycles_amounts') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_amounts" CHECK (((contract_value_minor >= 0) AND (renewal_count >= 0) AND ((risk_score >= 0) AND (risk_score <= 100))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'chk_customer_lifecycles_closure') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "chk_customer_lifecycles_closure" CHECK ((((status = 'active'::text) AND (closed_at IS NULL) AND (closed_reason IS NULL)) OR ((status <> 'active'::text) AND (closed_at IS NOT NULL) AND (closed_reason IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'uniq_customer_lifecycles_org_id') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "uniq_customer_lifecycles_org_id" UNIQUE (organization_id, customer_lifecycle_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_pkey') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_pkey" PRIMARY KEY (lifecycle_signal_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'chk_customer_lifecycle_signals_kind') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_kind" CHECK ((kind = ANY (ARRAY['support-escalation'::text, 'invoice-overdue'::text, 'champion-departed'::text, 'usage-decline'::text, 'detractor-response'::text, 'relationship-silence'::text, 'expansion-interest'::text, 'renewal-commitment'::text, 'note'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'chk_customer_lifecycle_signals_source') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "chk_customer_lifecycle_signals_source" CHECK ((source = ANY (ARRAY['system'::text, 'human'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_pkey') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_pkey" PRIMARY KEY (customer_health_assessment_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'chk_customer_health_assessments_score') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_score" CHECK (((score IS NULL) OR ((score >= 0) AND (score <= 100))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'chk_customer_health_assessments_coverage') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_coverage" CHECK (((coverage_bps >= 0) AND (coverage_bps <= 10000)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'chk_customer_health_assessments_band') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "chk_customer_health_assessments_band" CHECK ((((score IS NULL) AND (health_status IS NULL)) OR ((score IS NOT NULL) AND (health_status IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'uniq_customer_health_assessments_org_id') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "uniq_customer_health_assessments_org_id" UNIQUE (organization_id, customer_health_assessment_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_pkey') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_pkey" PRIMARY KEY (customer_health_factor_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_key') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_key" CHECK ((factor_key = ANY (ARRAY['usage'::text, 'engagement'::text, 'support'::text, 'sentiment'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_status') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_status" CHECK ((status = ANY (ARRAY['measured'::text, 'missing'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_evidence') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_evidence" CHECK ((((status = 'measured'::text) AND (value IS NOT NULL) AND (missing_reason IS NULL)) OR ((status = 'missing'::text) AND (value IS NULL) AND (missing_reason IS NOT NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_reason') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_reason" CHECK (((missing_reason IS NULL) OR (missing_reason = ANY (ARRAY['no-source'::text, 'no-observations'::text, 'stale'::text]))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_amounts') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_amounts" CHECK ((((weight_bps >= 0) AND (weight_bps <= 10000)) AND ((effective_weight_bps >= 0) AND (effective_weight_bps <= 10000)) AND (contribution_bps >= 0) AND (observations >= 0) AND (window_days > 0) AND (window_to > window_from) AND ((value IS NULL) OR ((value >= 0) AND (value <= 100)))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'chk_customer_health_factors_missing_weightless') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "chk_customer_health_factors_missing_weightless" CHECK (((status = 'measured'::text) OR ((effective_weight_bps = 0) AND (contribution_bps = 0) AND (observations = 0))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_pkey') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_pkey" PRIMARY KEY (customer_lifecycle_trigger_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_kind') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_kind" CHECK ((kind = ANY (ARRAY['renewal-due'::text, 'churn-risk'::text])));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_outcome') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_outcome" CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['held'::text, 'skipped'::text]))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_stage') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_stage" CHECK (((refusal_stage IS NULL) OR (refusal_stage = ANY (ARRAY['opportunity'::text, 'eligibility'::text, 'draft'::text, 'confidence'::text, 'loop-error'::text]))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_evidence') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_evidence" CHECK ((((outcome IS NULL) AND (refusal_stage IS NULL) AND (refusal_reason IS NULL) AND (autonomy_hold_id IS NULL) AND (outbound_message_id IS NULL)) OR ((outcome = 'held'::text) AND (refusal_stage IS NULL) AND (refusal_reason IS NULL) AND (autonomy_hold_id IS NOT NULL) AND (outbound_message_id IS NOT NULL)) OR ((outcome = 'skipped'::text) AND (refusal_stage IS NOT NULL) AND (refusal_reason IS NOT NULL) AND (autonomy_hold_id IS NULL) AND (outbound_message_id IS NULL))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_attempts') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_attempts" CHECK (((attempts >= 0) AND ((outcome IS NULL) OR ((attempts > 0) AND (last_attempt_at IS NOT NULL)))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_scores') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_scores" CHECK ((((risk_score >= 0) AND (risk_score <= 100)) AND ((health_score IS NULL) OR ((health_score >= 0) AND (health_score <= 100)))));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'chk_customer_lifecycle_triggers_dates') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "chk_customer_lifecycle_triggers_dates" CHECK (((due_on <= renewal_on) AND (due_on >= term_started_on)));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_pkey') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_pkey" PRIMARY KEY (report_definition_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_pkey') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_pkey" PRIMARY KEY (report_run_id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_pkey') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_pkey" PRIMARY KEY (measurement_id);
  END IF;
END $repair$;
--> statement-breakpoint
--
-- not-null constraints (648)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'crm_org_party_map_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "crm_org_party_map_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'crm_org_party_map_crm_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "crm_org_party_map_crm_organization_id_not_null" NOT NULL crm_organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'crm_org_party_map_party_id_not_null') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "crm_org_party_map_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'crm_org_party_map_created_at_not_null') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "crm_org_party_map_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_relationship_state_id_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_relationship_state_id_not_null" NOT NULL relationship_state_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_organization_id_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_contact_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_contact_count_not_null" NOT NULL contact_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_inbound_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_inbound_count_not_null" NOT NULL inbound_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_outbound_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_outbound_count_not_null" NOT NULL outbound_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_unreadable_direction_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_unreadable_direction_count_not_null" NOT NULL unreadable_direction_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_reply_sample_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_reply_sample_count_not_null" NOT NULL reply_sample_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_participant_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_participant_count_not_null" NOT NULL participant_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_thread_count_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_thread_count_not_null" NOT NULL thread_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_built_at_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_built_at_not_null" NOT NULL built_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_created_at_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'relationship_states_updated_at_not_null') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "relationship_states_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_relationship_participant_id_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_relationship_participant_id_not_null" NOT NULL relationship_participant_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_organization_id_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_relationship_state_id_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_relationship_state_id_not_null" NOT NULL relationship_state_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_identity_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_identity_not_null" NOT NULL identity;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_roles_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_roles_not_null" NOT NULL roles;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_first_seen_at_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_first_seen_at_not_null" NOT NULL first_seen_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_last_seen_at_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_last_seen_at_not_null" NOT NULL last_seen_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_message_count_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_message_count_not_null" NOT NULL message_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_replied_count_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_replied_count_not_null" NOT NULL replied_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'relationship_participants_created_at_not_null') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "relationship_participants_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_relationship_thread_id_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_relationship_thread_id_not_null" NOT NULL relationship_thread_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_organization_id_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_relationship_state_id_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_relationship_state_id_not_null" NOT NULL relationship_state_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_thread_id_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_thread_id_not_null" NOT NULL thread_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_first_seen_at_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_first_seen_at_not_null" NOT NULL first_seen_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_last_seen_at_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_last_seen_at_not_null" NOT NULL last_seen_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_message_count_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_message_count_not_null" NOT NULL message_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'relationship_threads_created_at_not_null') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "relationship_threads_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_stock_transactions' AND k.conname = 'inv_stock_transactions_quantity_bucket_not_null') THEN
    ALTER TABLE "public"."inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_quantity_bucket_not_null" NOT NULL quantity_bucket;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_subprocessor_id_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_subprocessor_id_not_null" NOT NULL subprocessor_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_name_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_purpose_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_purpose_not_null" NOT NULL purpose;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_location_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_location_not_null" NOT NULL location;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_effective_from_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_effective_from_not_null" NOT NULL effective_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_created_at_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'subprocessors_updated_at_not_null') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "subprocessors_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessor_subscribers' AND k.conname = 'subprocessor_subscribers_subprocessor_subscriber_id_not_null') THEN
    ALTER TABLE "public"."subprocessor_subscribers" ADD CONSTRAINT "subprocessor_subscribers_subprocessor_subscriber_id_not_null" NOT NULL subprocessor_subscriber_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessor_subscribers' AND k.conname = 'subprocessor_subscribers_email_not_null') THEN
    ALTER TABLE "public"."subprocessor_subscribers" ADD CONSTRAINT "subprocessor_subscribers_email_not_null" NOT NULL email;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessor_subscribers' AND k.conname = 'subprocessor_subscribers_created_at_not_null') THEN
    ALTER TABLE "public"."subprocessor_subscribers" ADD CONSTRAINT "subprocessor_subscribers_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_subject_request_id_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_subject_request_id_not_null" NOT NULL subject_request_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_kind_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_subject_email_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_subject_email_not_null" NOT NULL subject_email;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_is_complete_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_is_complete_not_null" NOT NULL is_complete;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_total_records_affected_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_total_records_affected_not_null" NOT NULL total_records_affected;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subject_requests' AND k.conname = 'subject_requests_requested_at_not_null') THEN
    ALTER TABLE "public"."subject_requests" ADD CONSTRAINT "subject_requests_requested_at_not_null" NOT NULL requested_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_crm_deal_forecast_model_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_crm_deal_forecast_model_id_not_null" NOT NULL crm_deal_forecast_model_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_feature_spec_version_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_feature_spec_version_not_null" NOT NULL feature_spec_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_status_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_trained_at_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_trained_at_not_null" NOT NULL trained_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_became_available_at_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_became_available_at_not_null" NOT NULL became_available_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_training_deals_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_training_deals_not_null" NOT NULL training_deals;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_holdout_deals_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_holdout_deals_not_null" NOT NULL holdout_deals;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_won_deals_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_won_deals_not_null" NOT NULL won_deals;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_lost_deals_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_lost_deals_not_null" NOT NULL lost_deals;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_coefficients_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_coefficients_not_null" NOT NULL coefficients;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_evaluation_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_evaluation_not_null" NOT NULL evaluation;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_ridge_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_ridge_not_null" NOT NULL ridge;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_iterations_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_iterations_not_null" NOT NULL iterations;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_converged_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_converged_not_null" NOT NULL converged;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'crm_deal_forecast_models_created_at_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "crm_deal_forecast_models_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_crm_deal_forecast_score_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_crm_deal_forecast_score_id_not_null" NOT NULL crm_deal_forecast_score_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_deal_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_deal_id_not_null" NOT NULL deal_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_crm_deal_forecast_model_id_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_crm_deal_forecast_model_id_not_null" NOT NULL crm_deal_forecast_model_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_as_of_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_as_of_not_null" NOT NULL as_of;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_scored_at_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_scored_at_not_null" NOT NULL scored_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_probability_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_probability_not_null" NOT NULL probability;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_interval_lower_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_interval_lower_not_null" NOT NULL interval_lower;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_interval_upper_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_interval_upper_not_null" NOT NULL interval_upper;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_expected_value_minor_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_expected_value_minor_not_null" NOT NULL expected_value_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_features_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_features_not_null" NOT NULL features;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_factors_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_factors_not_null" NOT NULL factors;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'crm_deal_forecast_scores_created_at_not_null') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "crm_deal_forecast_scores_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_autonomy_repair_policy_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_autonomy_repair_policy_id_not_null" NOT NULL autonomy_repair_policy_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_organization_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_repair_class_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_repair_class_not_null" NOT NULL repair_class;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_enabled_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_enabled_not_null" NOT NULL enabled;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_created_at_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'autonomy_repair_policies_updated_at_not_null') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "autonomy_repair_policies_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_autonomy_repair_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_autonomy_repair_id_not_null" NOT NULL autonomy_repair_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_organization_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_autonomous_decision_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_autonomous_decision_id_not_null" NOT NULL autonomous_decision_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_repair_class_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_repair_class_not_null" NOT NULL repair_class;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_party_id_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_field_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_field_not_null" NOT NULL field;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'autonomy_repairs_applied_at_not_null') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "autonomy_repairs_applied_at_not_null" NOT NULL applied_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_outbound_message_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_outbound_message_id_not_null" NOT NULL outbound_message_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_party_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_outbound_class_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_outbound_class_not_null" NOT NULL outbound_class;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_track_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_track_not_null" NOT NULL track;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_channel_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_channel_not_null" NOT NULL channel;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_subject_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_subject_not_null" NOT NULL subject;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_body_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_body_not_null" NOT NULL body;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_status_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_working_hour_deferrals_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_working_hour_deferrals_not_null" NOT NULL working_hour_deferrals;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_autonomous_decision_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_autonomous_decision_id_not_null" NOT NULL autonomous_decision_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_created_at_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'crm_outbound_messages_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "crm_outbound_messages_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_id_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_org_id_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_name_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_country_code_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_country_code_not_null" NOT NULL country_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_base_currency_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_base_currency_not_null" NOT NULL base_currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_localization_pack_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_localization_pack_not_null" NOT NULL localization_pack;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_fiscal_year_start_month_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_fiscal_year_start_month_not_null" NOT NULL fiscal_year_start_month;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_fiscal_year_start_day_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_fiscal_year_start_day_not_null" NOT NULL fiscal_year_start_day;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_timezone_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_timezone_not_null" NOT NULL timezone;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_is_default_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_is_default_not_null" NOT NULL is_default;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_status_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_created_at_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'gl_currencies_code_not_null') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "gl_currencies_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'gl_currencies_name_not_null') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "gl_currencies_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'gl_currencies_minor_units_not_null') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "gl_currencies_minor_units_not_null" NOT NULL minor_units;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_currencies' AND k.conname = 'gl_currencies_is_active_not_null') THEN
    ALTER TABLE "public"."gl_currencies" ADD CONSTRAINT "gl_currencies_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_id_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_org_id_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_book_id_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_currency_code_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_currency_code_not_null" NOT NULL currency_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_is_base_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_is_base_not_null" NOT NULL is_base;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_created_at_not_null') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_id_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_org_id_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_book_id_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_from_code_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_from_code_not_null" NOT NULL from_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_to_code_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_to_code_not_null" NOT NULL to_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_rate_date_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_rate_date_not_null" NOT NULL rate_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_rate_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_rate_not_null" NOT NULL rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_source_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_source_not_null" NOT NULL source;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_captured_at_not_null') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_captured_at_not_null" NOT NULL captured_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_id_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_org_id_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_book_id_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_code_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_name_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_account_type_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_account_type_not_null" NOT NULL account_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_is_header_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_is_header_not_null" NOT NULL is_header;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_is_active_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_is_cash_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_is_cash_not_null" NOT NULL is_cash;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_created_at_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_id_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_org_id_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_book_id_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_name_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_starts_on_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_starts_on_not_null" NOT NULL starts_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_ends_on_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_ends_on_not_null" NOT NULL ends_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_status_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_created_at_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_id_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_org_id_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_book_id_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_fiscal_year_id_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_fiscal_year_id_not_null" NOT NULL fiscal_year_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_name_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_starts_on_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_starts_on_not_null" NOT NULL starts_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_ends_on_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_ends_on_not_null" NOT NULL ends_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_sequence_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_sequence_not_null" NOT NULL sequence;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_outbound_class_stop_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_outbound_class_stop_id_not_null" NOT NULL outbound_class_stop_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_party_id_not_null') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_outbound_class_not_null') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_outbound_class_not_null" NOT NULL outbound_class;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'crm_outbound_class_stops_stopped_at_not_null') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "crm_outbound_class_stops_stopped_at_not_null" NOT NULL stopped_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'crm_cold_outbound_settings_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "crm_cold_outbound_settings_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'crm_cold_outbound_settings_enabled_not_null') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "crm_cold_outbound_settings_enabled_not_null" NOT NULL enabled;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'crm_cold_outbound_settings_created_at_not_null') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "crm_cold_outbound_settings_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'crm_cold_outbound_settings_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "crm_cold_outbound_settings_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_sending_domain_id_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_sending_domain_id_not_null" NOT NULL sending_domain_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_domain_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_domain_not_null" NOT NULL domain;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_purpose_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_purpose_not_null" NOT NULL purpose;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_status_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_created_at_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'crm_sending_domains_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "crm_sending_domains_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_created_at_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_id_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_org_id_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_book_id_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_period_id_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_period_id_not_null" NOT NULL period_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_journal_number_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_journal_number_not_null" NOT NULL journal_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_journal_date_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_journal_date_not_null" NOT NULL journal_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_source_type_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_source_type_not_null" NOT NULL source_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_idempotency_key_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_idempotency_key_not_null" NOT NULL idempotency_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_posted_at_not_null') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_posted_at_not_null" NOT NULL posted_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_id_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_org_id_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_book_id_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_journal_id_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_journal_id_not_null" NOT NULL journal_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_line_no_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_line_no_not_null" NOT NULL line_no;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_account_id_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_account_id_not_null" NOT NULL account_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_debit_minor_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_debit_minor_not_null" NOT NULL debit_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_credit_minor_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_credit_minor_not_null" NOT NULL credit_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_txn_currency_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_txn_currency_not_null" NOT NULL txn_currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_txn_amount_minor_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_txn_amount_minor_not_null" NOT NULL txn_amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_functional_currency_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_functional_currency_not_null" NOT NULL functional_currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_functional_amount_minor_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_functional_amount_minor_not_null" NOT NULL functional_amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_fx_rate_not_null') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_fx_rate_not_null" NOT NULL fx_rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_id_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_org_id_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_book_id_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_kind_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_prefix_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_prefix_not_null" NOT NULL prefix;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_pattern_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_pattern_not_null" NOT NULL pattern;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_padding_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_padding_not_null" NOT NULL padding;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_next_number_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_next_number_not_null" NOT NULL next_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_created_at_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_id_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_org_id_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_book_id_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_pack_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_pack_not_null" NOT NULL pack;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_code_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_code_not_null" NOT NULL code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_name_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_category_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_category_not_null" NOT NULL category;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_is_system_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_is_system_not_null" NOT NULL is_system;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_is_active_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_created_at_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_updated_at_not_null') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_id_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_org_id_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_tax_code_id_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_tax_code_id_not_null" NOT NULL tax_code_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_component_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_component_not_null" NOT NULL component;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_jurisdiction_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_jurisdiction_not_null" NOT NULL jurisdiction;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_rate_bp_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_rate_bp_not_null" NOT NULL rate_bp;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_effective_from_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_effective_from_not_null" NOT NULL effective_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_created_at_not_null') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_id_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_org_id_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_owner_type_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_owner_type_not_null" NOT NULL owner_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_regime_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_regime_not_null" NOT NULL regime;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_number_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_number_not_null" NOT NULL number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_country_code_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_country_code_not_null" NOT NULL country_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_is_primary_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_is_primary_not_null" NOT NULL is_primary;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_created_at_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_updated_at_not_null') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_id_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_org_id_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_book_id_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_gl_role_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_gl_role_not_null" NOT NULL gl_role;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_component_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_component_not_null" NOT NULL component;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_account_id_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_account_id_not_null" NOT NULL account_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_created_at_not_null') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_id_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_org_id_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_book_id_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_document_type_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_document_type_not_null" NOT NULL document_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_document_id_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_component_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_component_not_null" NOT NULL component;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_jurisdiction_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_jurisdiction_not_null" NOT NULL jurisdiction;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_rate_bp_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_rate_bp_not_null" NOT NULL rate_bp;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_taxable_minor_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_taxable_minor_not_null" NOT NULL taxable_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_tax_minor_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_tax_minor_not_null" NOT NULL tax_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_currency_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_gl_role_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_gl_role_not_null" NOT NULL gl_role;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_recoverable_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_recoverable_not_null" NOT NULL recoverable;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_created_at_not_null') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_id_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_org_id_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_book_id_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_role_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_role_not_null" NOT NULL role;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_display_name_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_display_name_not_null" NOT NULL display_name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_country_code_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_country_code_not_null" NOT NULL country_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_default_currency_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_default_currency_not_null" NOT NULL default_currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_external_refs_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_external_refs_not_null" NOT NULL external_refs;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_payment_terms_days_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_payment_terms_days_not_null" NOT NULL payment_terms_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_is_active_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_created_at_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_id_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND k.conname = 'custom_field_definitions_project_id_not_null') THEN
    ALTER TABLE "public"."custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_project_id_not_null" NOT NULL project_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'custom_field_definitions' AND k.conname = 'custom_field_definitions_is_sensitive_not_null') THEN
    ALTER TABLE "public"."custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_is_sensitive_not_null" NOT NULL is_sensitive;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_org_id_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_book_id_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_party_id_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_document_type_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_document_type_not_null" NOT NULL document_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_status_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_issue_date_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_issue_date_not_null" NOT NULL issue_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_currency_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_fx_rate_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_fx_rate_not_null" NOT NULL fx_rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_supply_nature_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_supply_nature_not_null" NOT NULL supply_nature;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_tax_inclusive_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_tax_inclusive_not_null" NOT NULL tax_inclusive;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_net_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_net_minor_not_null" NOT NULL net_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_tax_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_tax_minor_not_null" NOT NULL tax_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_gross_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_gross_minor_not_null" NOT NULL gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_rounding_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_rounding_minor_not_null" NOT NULL rounding_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_functional_gross_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_functional_gross_minor_not_null" NOT NULL functional_gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_settled_minor_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_settled_minor_not_null" NOT NULL settled_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_export_with_igst_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_export_with_igst_not_null" NOT NULL export_with_igst;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_created_at_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_updated_at_not_null') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_id_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_org_id_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_document_id_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_line_no_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_line_no_not_null" NOT NULL line_no;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_description_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_description_not_null" NOT NULL description;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_quantity_milli_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_quantity_milli_not_null" NOT NULL quantity_milli;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_unit_price_minor_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_unit_price_minor_not_null" NOT NULL unit_price_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_discount_minor_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_discount_minor_not_null" NOT NULL discount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_tax_category_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_tax_category_not_null" NOT NULL tax_category;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_line_net_minor_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_line_net_minor_not_null" NOT NULL line_net_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_line_tax_minor_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_line_tax_minor_not_null" NOT NULL line_tax_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_line_gross_minor_not_null') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_line_gross_minor_not_null" NOT NULL line_gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_id_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_org_id_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_book_id_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_party_id_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_receipt_date_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_receipt_date_not_null" NOT NULL receipt_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_deposit_account_id_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_deposit_account_id_not_null" NOT NULL deposit_account_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_currency_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_fx_rate_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_fx_rate_not_null" NOT NULL fx_rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_amount_minor_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_unapplied_minor_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_unapplied_minor_not_null" NOT NULL unapplied_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_status_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_created_at_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_updated_at_not_null') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_id_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_org_id_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_book_id_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_document_id_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_amount_minor_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_created_at_not_null') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_id_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_org_id_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_book_id_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_party_id_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_document_type_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_document_type_not_null" NOT NULL document_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_status_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_issue_date_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_issue_date_not_null" NOT NULL issue_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_currency_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_fx_rate_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_fx_rate_not_null" NOT NULL fx_rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_supply_nature_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_supply_nature_not_null" NOT NULL supply_nature;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_tax_inclusive_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_tax_inclusive_not_null" NOT NULL tax_inclusive;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_reverse_charge_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_reverse_charge_not_null" NOT NULL reverse_charge;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_blocked_input_tax_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_blocked_input_tax_not_null" NOT NULL blocked_input_tax;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_net_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_net_minor_not_null" NOT NULL net_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_tax_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_tax_minor_not_null" NOT NULL tax_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_gross_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_gross_minor_not_null" NOT NULL gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_rounding_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_rounding_minor_not_null" NOT NULL rounding_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_functional_gross_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_functional_gross_minor_not_null" NOT NULL functional_gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_settled_minor_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_settled_minor_not_null" NOT NULL settled_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_created_at_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_updated_at_not_null') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_id_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_org_id_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_document_id_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_line_no_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_line_no_not_null" NOT NULL line_no;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_description_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_description_not_null" NOT NULL description;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_quantity_milli_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_quantity_milli_not_null" NOT NULL quantity_milli;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_unit_price_minor_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_unit_price_minor_not_null" NOT NULL unit_price_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_discount_minor_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_discount_minor_not_null" NOT NULL discount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_tax_category_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_tax_category_not_null" NOT NULL tax_category;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_capitalize_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_capitalize_not_null" NOT NULL capitalize;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_line_net_minor_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_line_net_minor_not_null" NOT NULL line_net_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_line_tax_minor_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_line_tax_minor_not_null" NOT NULL line_tax_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_line_gross_minor_not_null') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_line_gross_minor_not_null" NOT NULL line_gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_id_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_org_id_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_book_id_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_party_id_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_payment_date_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_payment_date_not_null" NOT NULL payment_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_payment_account_id_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_payment_account_id_not_null" NOT NULL payment_account_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_currency_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_fx_rate_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_fx_rate_not_null" NOT NULL fx_rate;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_gross_minor_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_gross_minor_not_null" NOT NULL gross_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_withheld_minor_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_withheld_minor_not_null" NOT NULL withheld_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_net_paid_minor_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_net_paid_minor_not_null" NOT NULL net_paid_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_unapplied_minor_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_unapplied_minor_not_null" NOT NULL unapplied_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_status_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_created_at_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_updated_at_not_null') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_id_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_org_id_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_book_id_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_document_id_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_amount_minor_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_created_at_not_null') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_id_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_org_id_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_book_id_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_payment_id_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_payment_id_not_null" NOT NULL payment_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_regime_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_regime_not_null" NOT NULL regime;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_rate_bp_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_rate_bp_not_null" NOT NULL rate_bp;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_base_minor_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_base_minor_not_null" NOT NULL base_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_withheld_minor_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_withheld_minor_not_null" NOT NULL withheld_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_currency_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_created_at_not_null') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_id_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_org_id_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_book_id_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_account_id_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_account_id_not_null" NOT NULL account_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_display_name_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_display_name_not_null" NOT NULL display_name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_currency_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_country_code_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_country_code_not_null" NOT NULL country_code;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_is_active_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_is_active_not_null" NOT NULL is_active;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_created_at_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_updated_at_not_null') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_id_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_org_id_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_book_id_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_bank_profile_id_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_bank_profile_id_not_null" NOT NULL bank_profile_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_source_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_source_not_null" NOT NULL source;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_period_start_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_period_start_not_null" NOT NULL period_start;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_period_end_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_period_end_not_null" NOT NULL period_end;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_opening_minor_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_opening_minor_not_null" NOT NULL opening_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_closing_minor_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_closing_minor_not_null" NOT NULL closing_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_currency_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_imported_at_not_null') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_imported_at_not_null" NOT NULL imported_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_id_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_org_id_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_statement_id_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_not_null" NOT NULL statement_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_line_no_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_line_no_not_null" NOT NULL line_no;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_value_date_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_value_date_not_null" NOT NULL value_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_amount_minor_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_created_at_not_null') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_id_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_org_id_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_book_id_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_statement_line_id_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_statement_line_id_not_null" NOT NULL statement_line_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_kind_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_matched_at_not_null') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_matched_at_not_null" NOT NULL matched_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_id_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_org_id_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_book_id_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_document_type_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_document_type_not_null" NOT NULL document_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_document_id_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_transport_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_transport_not_null" NOT NULL transport;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_status_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_enforcement_at_post_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_enforcement_at_post_not_null" NOT NULL enforcement_at_post;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_created_at_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_updated_at_not_null') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND k.conname = 'inv_import_jobs_chunk_size_not_null') THEN
    ALTER TABLE "public"."inv_import_jobs" ADD CONSTRAINT "inv_import_jobs_chunk_size_not_null" NOT NULL chunk_size;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND k.conname = 'inv_import_jobs_next_row_not_null') THEN
    ALTER TABLE "public"."inv_import_jobs" ADD CONSTRAINT "inv_import_jobs_next_row_not_null" NOT NULL next_row;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_jobs' AND k.conname = 'inv_import_jobs_staged_rows_not_null') THEN
    ALTER TABLE "public"."inv_import_jobs" ADD CONSTRAINT "inv_import_jobs_staged_rows_not_null" NOT NULL staged_rows;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_id_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_org_id_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_job_id_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_job_id_not_null" NOT NULL job_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_row_number_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_row_number_not_null" NOT NULL row_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_payload_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_payload_not_null" NOT NULL payload;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_status_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_created_at_not_null') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_id_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_id_not_null" NOT NULL id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_org_id_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_book_id_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_book_id_not_null" NOT NULL book_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_document_type_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_document_type_not_null" NOT NULL document_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_document_id_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_document_id_not_null" NOT NULL document_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_file_name_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_file_name_not_null" NOT NULL file_name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_mime_type_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_mime_type_not_null" NOT NULL mime_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_size_bytes_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_size_bytes_not_null" NOT NULL size_bytes;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_storage_key_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_storage_key_not_null" NOT NULL storage_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_created_at_not_null') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_created_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_first_refused_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_first_refused_at_not_null" NOT NULL first_refused_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_last_refused_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_last_refused_at_not_null" NOT NULL last_refused_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_call_analysis_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_call_analysis_id_not_null" NOT NULL call_analysis_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_transcript_hash_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_transcript_hash_not_null" NOT NULL transcript_hash;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_analyzer_version_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_analyzer_version_not_null" NOT NULL analyzer_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_activity_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_activity_id_not_null" NOT NULL activity_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_objections_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_objections_not_null" NOT NULL objections;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_competitor_mentions_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_competitor_mentions_not_null" NOT NULL competitor_mentions;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_next_step_committed_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_next_step_committed_not_null" NOT NULL next_step_committed;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_prompt_key_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_prompt_key_not_null" NOT NULL prompt_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_prompt_version_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_prompt_version_not_null" NOT NULL prompt_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_transcript_chars_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_transcript_chars_not_null" NOT NULL transcript_chars;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_created_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'crm_call_analyses_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "crm_call_analyses_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_note_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_note_not_null" NOT NULL note;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_call_analysis_release_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_call_analysis_release_id_not_null" NOT NULL call_analysis_release_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_activity_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_activity_id_not_null" NOT NULL activity_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_analyzer_version_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_analyzer_version_not_null" NOT NULL analyzer_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_released_by_user_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_released_by_user_id_not_null" NOT NULL released_by_user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'crm_call_analysis_releases_released_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "crm_call_analysis_releases_released_at_not_null" NOT NULL released_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_call_recording_consent_id_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_call_recording_consent_id_not_null" NOT NULL call_recording_consent_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_activity_id_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_activity_id_not_null" NOT NULL activity_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_jurisdiction_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_jurisdiction_not_null" NOT NULL jurisdiction;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_attested_by_user_id_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_attested_by_user_id_not_null" NOT NULL attested_by_user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_created_at_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'crm_call_recording_consent_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "crm_call_recording_consent_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_call_analysis_refusal_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_call_analysis_refusal_id_not_null" NOT NULL call_analysis_refusal_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_activity_id_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_activity_id_not_null" NOT NULL activity_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_reason_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_reason_not_null" NOT NULL reason;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_rule_version_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_rule_version_not_null" NOT NULL rule_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_attempts_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_attempts_not_null" NOT NULL attempts;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'crm_call_analysis_refusals_created_at_not_null') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "crm_call_analysis_refusals_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_name_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_currency_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_created_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'crm_commission_plans_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "crm_commission_plans_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_plan_version_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_plan_version_id_not_null" NOT NULL plan_version_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_version_number_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_version_number_not_null" NOT NULL version_number;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_effective_from_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_effective_from_not_null" NOT NULL effective_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_rules_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_rules_not_null" NOT NULL rules;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_created_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'crm_commission_plan_versions_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "crm_commission_plan_versions_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_prior_basis_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_prior_basis_minor_not_null" NOT NULL prior_basis_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_amount_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_currency_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_effective_rate_bps_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_effective_rate_bps_not_null" NOT NULL effective_rate_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_assignment_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_assignment_id_not_null" NOT NULL assignment_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_user_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_effective_from_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_effective_from_not_null" NOT NULL effective_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_created_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'crm_commission_assignments_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "crm_commission_assignments_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_earning_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_earning_id_not_null" NOT NULL earning_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_plan_version_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_plan_version_id_not_null" NOT NULL plan_version_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_user_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_earned_on_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_earned_on_not_null" NOT NULL earned_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_period_start_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_period_start_not_null" NOT NULL period_start;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_period_end_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_period_end_not_null" NOT NULL period_end;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_source_type_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_source_type_not_null" NOT NULL source_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_source_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_source_id_not_null" NOT NULL source_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_basis_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_basis_minor_not_null" NOT NULL basis_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_status_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_created_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'crm_commission_earnings_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "crm_commission_earnings_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_slice_to_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_slice_to_minor_not_null" NOT NULL slice_to_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_basis_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_basis_minor_not_null" NOT NULL basis_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_part_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_part_id_not_null" NOT NULL part_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_earning_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_earning_id_not_null" NOT NULL earning_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_user_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_plan_version_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_plan_version_id_not_null" NOT NULL plan_version_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_earned_on_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_earned_on_not_null" NOT NULL earned_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_period_start_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_period_start_not_null" NOT NULL period_start;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_period_end_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_period_end_not_null" NOT NULL period_end;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_source_type_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_source_type_not_null" NOT NULL source_type;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_source_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_source_id_not_null" NOT NULL source_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_part_index_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_part_index_not_null" NOT NULL part_index;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_tier_index_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_tier_index_not_null" NOT NULL tier_index;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_tier_from_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_tier_from_not_null" NOT NULL tier_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_rate_bps_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_rate_bps_not_null" NOT NULL rate_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_multiplier_bps_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_multiplier_bps_not_null" NOT NULL multiplier_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_slice_from_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_slice_from_minor_not_null" NOT NULL slice_from_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_amount_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_amount_minor_not_null" NOT NULL amount_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_currency_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'crm_commission_accrual_parts_created_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "crm_commission_accrual_parts_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_snapshot_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_snapshot_id_not_null" NOT NULL snapshot_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_org_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_org_id_not_null" NOT NULL org_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_user_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_user_id_not_null" NOT NULL user_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_plan_id_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_plan_id_not_null" NOT NULL plan_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_period_start_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_period_start_not_null" NOT NULL period_start;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_period_end_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_period_end_not_null" NOT NULL period_end;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_as_of_date_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_as_of_date_not_null" NOT NULL as_of_date;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_accrued_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_accrued_minor_not_null" NOT NULL accrued_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_basis_minor_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_basis_minor_not_null" NOT NULL basis_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_earning_count_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_earning_count_not_null" NOT NULL earning_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_part_count_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_part_count_not_null" NOT NULL part_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_currency_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_currency_not_null" NOT NULL currency;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'crm_commission_accrual_snapshots_computed_at_not_null') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "crm_commission_accrual_snapshots_computed_at_not_null" NOT NULL computed_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_customer_lifecycle_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_customer_lifecycle_id_not_null" NOT NULL customer_lifecycle_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_organization_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_party_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_source_deal_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_source_deal_id_not_null" NOT NULL source_deal_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_status_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_started_on_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_started_on_not_null" NOT NULL started_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_term_months_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_term_months_not_null" NOT NULL term_months;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_renewal_on_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_renewal_on_not_null" NOT NULL renewal_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_contract_value_minor_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_contract_value_minor_not_null" NOT NULL contract_value_minor;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_renewal_count_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_renewal_count_not_null" NOT NULL renewal_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_risk_score_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_risk_score_not_null" NOT NULL risk_score;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_created_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'customer_lifecycles_updated_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "customer_lifecycles_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_observations_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_observations_not_null" NOT NULL observations;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_lifecycle_signal_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_lifecycle_signal_id_not_null" NOT NULL lifecycle_signal_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_organization_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_customer_lifecycle_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_customer_lifecycle_id_not_null" NOT NULL customer_lifecycle_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_kind_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_impact_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_impact_not_null" NOT NULL impact;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_observed_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_observed_at_not_null" NOT NULL observed_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_source_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_source_not_null" NOT NULL source;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'customer_lifecycle_signals_created_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "customer_lifecycle_signals_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_customer_health_assessment_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_customer_health_assessment_not_null" NOT NULL customer_health_assessment_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_organization_id_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_party_id_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_coverage_bps_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_coverage_bps_not_null" NOT NULL coverage_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_weights_version_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_weights_version_not_null" NOT NULL weights_version;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_computed_at_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_computed_at_not_null" NOT NULL computed_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_created_at_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'customer_health_assessments_updated_at_not_null') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "customer_health_assessments_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_customer_health_factor_id_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_customer_health_factor_id_not_null" NOT NULL customer_health_factor_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_organization_id_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_customer_health_assessment_id_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_customer_health_assessment_id_not_null" NOT NULL customer_health_assessment_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_factor_key_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_factor_key_not_null" NOT NULL factor_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_weight_bps_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_weight_bps_not_null" NOT NULL weight_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_effective_weight_bps_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_effective_weight_bps_not_null" NOT NULL effective_weight_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_status_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_status_not_null" NOT NULL status;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_contribution_bps_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_contribution_bps_not_null" NOT NULL contribution_bps;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_window_days_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_window_days_not_null" NOT NULL window_days;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_window_from_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_window_from_not_null" NOT NULL window_from;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_window_to_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_window_to_not_null" NOT NULL window_to;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_detail_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_detail_not_null" NOT NULL detail;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'customer_health_factors_created_at_not_null') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "customer_health_factors_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_customer_lifecycle_trigger_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_customer_lifecycle_trigger_not_null" NOT NULL customer_lifecycle_trigger_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_organization_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_customer_lifecycle_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_customer_lifecycle_id_not_null" NOT NULL customer_lifecycle_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_party_id_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_party_id_not_null" NOT NULL party_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_kind_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_kind_not_null" NOT NULL kind;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_term_started_on_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_term_started_on_not_null" NOT NULL term_started_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_renewal_on_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_renewal_on_not_null" NOT NULL renewal_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_due_on_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_due_on_not_null" NOT NULL due_on;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_risk_score_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_risk_score_not_null" NOT NULL risk_score;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_attempts_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_attempts_not_null" NOT NULL attempts;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_fired_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_fired_at_not_null" NOT NULL fired_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_created_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'customer_lifecycle_triggers_updated_at_not_null') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "customer_lifecycle_triggers_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_report_definition_id_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_report_definition_id_not_null" NOT NULL report_definition_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_name_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_name_not_null" NOT NULL name;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_source_key_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_source_key_not_null" NOT NULL source_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_query_description_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_query_description_not_null" NOT NULL query_description;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_created_at_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'crm_report_definitions_updated_at_not_null') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "crm_report_definitions_updated_at_not_null" NOT NULL updated_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_report_run_id_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_report_run_id_not_null" NOT NULL report_run_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_organization_id_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_organization_id_not_null" NOT NULL organization_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_source_key_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_source_key_not_null" NOT NULL source_key;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_compiled_sql_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_compiled_sql_not_null" NOT NULL compiled_sql;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_parameter_count_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_parameter_count_not_null" NOT NULL parameter_count;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'crm_report_runs_created_at_not_null') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "crm_report_runs_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_measurement_id_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_measurement_id_not_null" NOT NULL measurement_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_cell_id_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_cell_id_not_null" NOT NULL cell_id;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_limiting_resource_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_limiting_resource_not_null" NOT NULL limiting_resource;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_used_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_used_not_null" NOT NULL used;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_limit_value_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_limit_value_not_null" NOT NULL limit_value;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_per_org_cost_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_per_org_cost_not_null" NOT NULL per_org_cost;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_ceiling_source_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_ceiling_source_not_null" NOT NULL ceiling_source;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_measured_at_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_measured_at_not_null" NOT NULL measured_at;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'cell_capacity_measurements' AND k.conname = 'cell_capacity_measurements_created_at_not_null') THEN
    ALTER TABLE "public"."cell_capacity_measurements" ADD CONSTRAINT "cell_capacity_measurements_created_at_not_null" NOT NULL created_at;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- foreign keys (228)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'platform_waitlist' AND k.conname = 'fk_platform_waitlist_claimed_org') THEN
    ALTER TABLE "public"."platform_waitlist" ADD CONSTRAINT "fk_platform_waitlist_claimed_org" FOREIGN KEY (claimed_org_id) REFERENCES organizations(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'fk_crm_org_party_map_org') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "fk_crm_org_party_map_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_org_party_map' AND k.conname = 'fk_crm_org_party_map_party') THEN
    ALTER TABLE "public"."crm_org_party_map" ADD CONSTRAINT "fk_crm_org_party_map_party" FOREIGN KEY (organization_id, party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'calendar_events' AND k.conname = 'fk_calendar_events_linked_lead_party_id') THEN
    ALTER TABLE "public"."calendar_events" ADD CONSTRAINT "fk_calendar_events_linked_lead_party_id" FOREIGN KEY (org_id, linked_lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_accounts' AND k.conname = 'fk_client_accounts_lead_party_id') THEN
    ALTER TABLE "public"."client_accounts" ADD CONSTRAINT "fk_client_accounts_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_lead_touchpoints' AND k.conname = 'fk_crm_lead_touchpoints_lead_party_id') THEN
    ALTER TABLE "public"."crm_lead_touchpoints" ADD CONSTRAINT "fk_crm_lead_touchpoints_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND k.conname = 'fk_deals_lead_party_id') THEN
    ALTER TABLE "public"."deals" ADD CONSTRAINT "fk_deals_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_activities' AND k.conname = 'fk_lead_activities_lead_party_id') THEN
    ALTER TABLE "public"."lead_activities" ADD CONSTRAINT "fk_lead_activities_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_emails' AND k.conname = 'fk_lead_emails_lead_party_id') THEN
    ALTER TABLE "public"."lead_emails" ADD CONSTRAINT "fk_lead_emails_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_notes' AND k.conname = 'fk_lead_notes_lead_party_id') THEN
    ALTER TABLE "public"."lead_notes" ADD CONSTRAINT "fk_lead_notes_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_tasks' AND k.conname = 'fk_lead_tasks_lead_party_id') THEN
    ALTER TABLE "public"."lead_tasks" ADD CONSTRAINT "fk_lead_tasks_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_lead_party_id') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_lead_party_id" FOREIGN KEY (org_id, lead_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_contact_party_id') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_contact_party_id" FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'fk_relationship_states_org') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "fk_relationship_states_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_contact_party_id') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_contact_party_id" FOREIGN KEY (org_id, crm_contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_channel_consent' AND k.conname = 'fk_crm_contact_channel_consent_contact_party_id') THEN
    ALTER TABLE "public"."crm_contact_channel_consent" ADD CONSTRAINT "fk_crm_contact_channel_consent_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_consent_events' AND k.conname = 'fk_crm_contact_consent_events_contact_party_id') THEN
    ALTER TABLE "public"."crm_contact_consent_events" ADD CONSTRAINT "fk_crm_contact_consent_events_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_roles' AND k.conname = 'fk_crm_contact_roles_contact_party_id') THEN
    ALTER TABLE "public"."crm_contact_roles" ADD CONSTRAINT "fk_crm_contact_roles_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_stakeholders' AND k.conname = 'fk_crm_deal_stakeholders_contact_party_id') THEN
    ALTER TABLE "public"."crm_deal_stakeholders" ADD CONSTRAINT "fk_crm_deal_stakeholders_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND k.conname = 'fk_survey_participants_contact_party_id') THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_contact_party_id" FOREIGN KEY (org_id, contact_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND k.conname = 'fk_feedback_posts_crm_organization_party_id') THEN
    ALTER TABLE "build"."feedback_posts" ADD CONSTRAINT "fk_feedback_posts_crm_organization_party_id" FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'fk_relationship_participants_org') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "fk_relationship_participants_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_participants' AND k.conname = 'fk_relationship_participants_state') THEN
    ALTER TABLE "public"."relationship_participants" ADD CONSTRAINT "fk_relationship_participants_state" FOREIGN KEY (organization_id, relationship_state_id) REFERENCES relationship_states(organization_id, relationship_state_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'fk_relationship_threads_org') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "fk_relationship_threads_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND k.conname = 'fk_feedbucket_submissions_crm_organization_party_id') THEN
    ALTER TABLE "build"."feedbucket_submissions" ADD CONSTRAINT "fk_feedbucket_submissions_crm_organization_party_id" FOREIGN KEY (org_id, crm_organization_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer_org_party_id') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_org_party_id" FOREIGN KEY (org_id, customer_org_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_states' AND k.conname = 'fk_relationship_states_party') THEN
    ALTER TABLE "public"."relationship_states" ADD CONSTRAINT "fk_relationship_states_party" FOREIGN KEY (organization_id, party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'relationship_threads' AND k.conname = 'fk_relationship_threads_state') THEN
    ALTER TABLE "public"."relationship_threads" ADD CONSTRAINT "fk_relationship_threads_state" FOREIGN KEY (organization_id, relationship_state_id) REFERENCES relationship_states(organization_id, relationship_state_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND k.conname = 'fk_tickets_customer_party_id') THEN
    ALTER TABLE "build"."tickets" ADD CONSTRAINT "fk_tickets_customer_party_id" FOREIGN KEY (org_id, customer_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_onboarding_items' AND k.conname = 'fk_client_onboarding_items_client_party_id') THEN
    ALTER TABLE "public"."client_onboarding_items" ADD CONSTRAINT "fk_client_onboarding_items_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_opportunities' AND k.conname = 'fk_client_opportunities_client_party_id') THEN
    ALTER TABLE "public"."client_opportunities" ADD CONSTRAINT "fk_client_opportunities_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'csat_surveys' AND k.conname = 'fk_csat_surveys_client_party_id') THEN
    ALTER TABLE "public"."csat_surveys" ADD CONSTRAINT "fk_csat_surveys_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_sales_orders' AND k.conname = 'fk_inv_sales_orders_client_party_id') THEN
    ALTER TABLE "public"."inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_vendors' AND k.conname = 'fk_inv_vendors_client_party_id') THEN
    ALTER TABLE "public"."inv_vendors" ADD CONSTRAINT "fk_inv_vendors_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'invoices' AND k.conname = 'fk_invoices_client_party_id') THEN
    ALTER TABLE "public"."invoices" ADD CONSTRAINT "fk_invoices_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'purchase_bills' AND k.conname = 'fk_purchase_bills_vendor_party_id') THEN
    ALTER TABLE "public"."purchase_bills" ADD CONSTRAINT "fk_purchase_bills_vendor_party_id" FOREIGN KEY (org_id, vendor_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_tickets' AND k.conname = 'fk_support_tickets_client_party_id') THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "fk_support_tickets_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_vip_clients' AND k.conname = 'fk_support_vip_clients_client_party_id') THEN
    ALTER TABLE "public"."support_vip_clients" ADD CONSTRAINT "fk_support_vip_clients_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'timesheet_rates' AND k.conname = 'fk_timesheet_rates_client_party_id') THEN
    ALTER TABLE "public"."timesheet_rates" ADD CONSTRAINT "fk_timesheet_rates_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_returns' AND k.conname = 'fk_inv_customer_returns_client_party_id') THEN
    ALTER TABLE "public"."inv_customer_returns" ADD CONSTRAINT "fk_inv_customer_returns_client_party_id" FOREIGN KEY (org_id, client_party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'subprocessors' AND k.conname = 'fk_subprocessors_updated_by') THEN
    ALTER TABLE "public"."subprocessors" ADD CONSTRAINT "fk_subprocessors_updated_by" FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_models' AND k.conname = 'fk_crm_deal_forecast_models_org') THEN
    ALTER TABLE "public"."crm_deal_forecast_models" ADD CONSTRAINT "fk_crm_deal_forecast_models_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'fk_crm_deal_forecast_scores_org') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'fk_crm_deal_forecast_scores_deal') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_deal" FOREIGN KEY (organization_id, deal_id) REFERENCES deals(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_forecast_scores' AND k.conname = 'fk_crm_deal_forecast_scores_model') THEN
    ALTER TABLE "public"."crm_deal_forecast_scores" ADD CONSTRAINT "fk_crm_deal_forecast_scores_model" FOREIGN KEY (organization_id, crm_deal_forecast_model_id) REFERENCES crm_deal_forecast_models(organization_id, crm_deal_forecast_model_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repair_policies' AND k.conname = 'fk_autonomy_repair_policies_org') THEN
    ALTER TABLE "public"."autonomy_repair_policies" ADD CONSTRAINT "fk_autonomy_repair_policies_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_repairs' AND k.conname = 'fk_autonomy_repairs_org') THEN
    ALTER TABLE "public"."autonomy_repairs" ADD CONSTRAINT "fk_autonomy_repairs_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_org_id_fkey') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_legal_entity_id_fkey') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_legal_entity_id_fkey" FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_parent_book_id_fkey') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_parent_book_id_fkey" FOREIGN KEY (parent_book_id) REFERENCES gl_books(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_books' AND k.conname = 'gl_books_created_by_fkey') THEN
    ALTER TABLE "public"."gl_books" ADD CONSTRAINT "gl_books_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_org_id_fkey') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_book_id_fkey') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_book_currencies' AND k.conname = 'gl_book_currencies_currency_code_fkey') THEN
    ALTER TABLE "public"."gl_book_currencies" ADD CONSTRAINT "gl_book_currencies_currency_code_fkey" FOREIGN KEY (currency_code) REFERENCES gl_currencies(code) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_org_id_fkey') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_book_id_fkey') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fx_rates' AND k.conname = 'gl_fx_rates_created_by_fkey') THEN
    ALTER TABLE "public"."gl_fx_rates" ADD CONSTRAINT "gl_fx_rates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_org_id_fkey') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_book_id_fkey') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_accounts' AND k.conname = 'gl_accounts_parent_account_id_fkey') THEN
    ALTER TABLE "public"."gl_accounts" ADD CONSTRAINT "gl_accounts_parent_account_id_fkey" FOREIGN KEY (parent_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_org_id_fkey') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_fiscal_years' AND k.conname = 'gl_fiscal_years_book_id_fkey') THEN
    ALTER TABLE "public"."gl_fiscal_years" ADD CONSTRAINT "gl_fiscal_years_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_messages' AND k.conname = 'fk_crm_outbound_messages_org') THEN
    ALTER TABLE "public"."crm_outbound_messages" ADD CONSTRAINT "fk_crm_outbound_messages_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_outbound_class_stops' AND k.conname = 'fk_crm_outbound_class_stops_org') THEN
    ALTER TABLE "public"."crm_outbound_class_stops" ADD CONSTRAINT "fk_crm_outbound_class_stops_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_cold_outbound_settings' AND k.conname = 'fk_crm_cold_outbound_settings_org') THEN
    ALTER TABLE "public"."crm_cold_outbound_settings" ADD CONSTRAINT "fk_crm_cold_outbound_settings_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_sending_domains' AND k.conname = 'fk_crm_sending_domains_org') THEN
    ALTER TABLE "public"."crm_sending_domains" ADD CONSTRAINT "fk_crm_sending_domains_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_org_id_fkey') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_book_id_fkey') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_fiscal_year_id_fkey') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_fiscal_year_id_fkey" FOREIGN KEY (fiscal_year_id) REFERENCES gl_fiscal_years(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_periods' AND k.conname = 'gl_periods_locked_by_fkey') THEN
    ALTER TABLE "public"."gl_periods" ADD CONSTRAINT "gl_periods_locked_by_fkey" FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_org_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_book_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_period_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_period_id_fkey" FOREIGN KEY (period_id) REFERENCES gl_periods(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_reverses_journal_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_reverses_journal_id_fkey" FOREIGN KEY (reverses_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_reversed_by_journal_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_reversed_by_journal_id_fkey" FOREIGN KEY (reversed_by_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journals' AND k.conname = 'gl_journals_posted_by_user_id_fkey') THEN
    ALTER TABLE "public"."gl_journals" ADD CONSTRAINT "gl_journals_posted_by_user_id_fkey" FOREIGN KEY (posted_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_org_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_book_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_journal_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_journal_id_fkey" FOREIGN KEY (journal_id) REFERENCES gl_journals(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_account_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_account_id_fkey" FOREIGN KEY (account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_fx_rate_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_fx_rate_id_fkey" FOREIGN KEY (fx_rate_id) REFERENCES gl_fx_rates(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_dimension_branch_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_dimension_branch_id_fkey" FOREIGN KEY (dimension_branch_id) REFERENCES org_units(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_journal_lines' AND k.conname = 'gl_journal_lines_dimension_project_id_fkey') THEN
    ALTER TABLE "public"."gl_journal_lines" ADD CONSTRAINT "gl_journal_lines_dimension_project_id_fkey" FOREIGN KEY (dimension_project_id) REFERENCES build.projects(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_org_id_fkey') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_book_id_fkey') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_sequences' AND k.conname = 'gl_document_sequences_fiscal_year_id_fkey') THEN
    ALTER TABLE "public"."gl_document_sequences" ADD CONSTRAINT "gl_document_sequences_fiscal_year_id_fkey" FOREIGN KEY (fiscal_year_id) REFERENCES gl_fiscal_years(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'autonomy_holds' AND k.conname = 'fk_autonomy_holds_outbound_message') THEN
    ALTER TABLE "public"."autonomy_holds" ADD CONSTRAINT "fk_autonomy_holds_outbound_message" FOREIGN KEY (organization_id, outbound_message_id) REFERENCES crm_outbound_messages(organization_id, outbound_message_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_org_id_fkey') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_codes' AND k.conname = 'tax_codes_book_id_fkey') THEN
    ALTER TABLE "public"."tax_codes" ADD CONSTRAINT "tax_codes_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_org_id_fkey') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_rates' AND k.conname = 'tax_rates_tax_code_id_fkey') THEN
    ALTER TABLE "public"."tax_rates" ADD CONSTRAINT "tax_rates_tax_code_id_fkey" FOREIGN KEY (tax_code_id) REFERENCES tax_codes(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_org_id_fkey') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'tax_registrations_book_id_fkey') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "tax_registrations_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_org_id_fkey') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_book_id_fkey') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_gl_map' AND k.conname = 'tax_gl_map_account_id_fkey') THEN
    ALTER TABLE "public"."tax_gl_map" ADD CONSTRAINT "tax_gl_map_account_id_fkey" FOREIGN KEY (account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_org_id_fkey') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_book_id_fkey') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_tax_code_id_fkey') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_tax_code_id_fkey" FOREIGN KEY (tax_code_id) REFERENCES tax_codes(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_document_lines' AND k.conname = 'tax_document_lines_gl_account_id_fkey') THEN
    ALTER TABLE "public"."tax_document_lines" ADD CONSTRAINT "tax_document_lines_gl_account_id_fkey" FOREIGN KEY (gl_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_org_id_fkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_book_id_fkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_default_income_account_id_fkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_default_income_account_id_fkey" FOREIGN KEY (default_income_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_default_expense_account_id_fkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_default_expense_account_id_fkey" FOREIGN KEY (default_expense_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_parties' AND k.conname = 'gl_parties_created_by_fkey') THEN
    ALTER TABLE "public"."gl_parties" ADD CONSTRAINT "gl_parties_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'tax_registrations' AND k.conname = 'fk_tax_registrations_party') THEN
    ALTER TABLE "public"."tax_registrations" ADD CONSTRAINT "fk_tax_registrations_party" FOREIGN KEY (party_id) REFERENCES gl_parties(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_org_id_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_book_id_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_party_id_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_party_id_fkey" FOREIGN KEY (party_id) REFERENCES gl_parties(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_original_document_id_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_original_document_id_fkey" FOREIGN KEY (original_document_id) REFERENCES ar_documents(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_posted_journal_id_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_posted_journal_id_fkey" FOREIGN KEY (posted_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_posted_by_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_posted_by_fkey" FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_documents' AND k.conname = 'ar_documents_created_by_fkey') THEN
    ALTER TABLE "public"."ar_documents" ADD CONSTRAINT "ar_documents_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_org_id_fkey') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_document_id_fkey') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_document_id_fkey" FOREIGN KEY (document_id) REFERENCES ar_documents(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_document_lines' AND k.conname = 'ar_document_lines_income_account_id_fkey') THEN
    ALTER TABLE "public"."ar_document_lines" ADD CONSTRAINT "ar_document_lines_income_account_id_fkey" FOREIGN KEY (income_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_org_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_book_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_party_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_party_id_fkey" FOREIGN KEY (party_id) REFERENCES gl_parties(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_deposit_account_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_deposit_account_id_fkey" FOREIGN KEY (deposit_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_posted_journal_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_posted_journal_id_fkey" FOREIGN KEY (posted_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_reversal_journal_id_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_reversal_journal_id_fkey" FOREIGN KEY (reversal_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_receipts' AND k.conname = 'ar_receipts_created_by_fkey') THEN
    ALTER TABLE "public"."ar_receipts" ADD CONSTRAINT "ar_receipts_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_org_id_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_book_id_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_receipt_id_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_receipt_id_fkey" FOREIGN KEY (receipt_id) REFERENCES ar_receipts(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_credit_note_id_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_credit_note_id_fkey" FOREIGN KEY (credit_note_id) REFERENCES ar_documents(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_document_id_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_document_id_fkey" FOREIGN KEY (document_id) REFERENCES ar_documents(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ar_allocations' AND k.conname = 'ar_allocations_created_by_fkey') THEN
    ALTER TABLE "public"."ar_allocations" ADD CONSTRAINT "ar_allocations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_org_id_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_book_id_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_party_id_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_party_id_fkey" FOREIGN KEY (party_id) REFERENCES gl_parties(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_original_document_id_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_original_document_id_fkey" FOREIGN KEY (original_document_id) REFERENCES ap_documents(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_posted_journal_id_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_posted_journal_id_fkey" FOREIGN KEY (posted_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_posted_by_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_posted_by_fkey" FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_documents' AND k.conname = 'ap_documents_created_by_fkey') THEN
    ALTER TABLE "public"."ap_documents" ADD CONSTRAINT "ap_documents_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_org_id_fkey') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_document_id_fkey') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_document_id_fkey" FOREIGN KEY (document_id) REFERENCES ap_documents(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_document_lines' AND k.conname = 'ap_document_lines_expense_account_id_fkey') THEN
    ALTER TABLE "public"."ap_document_lines" ADD CONSTRAINT "ap_document_lines_expense_account_id_fkey" FOREIGN KEY (expense_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_org_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_book_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_party_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_party_id_fkey" FOREIGN KEY (party_id) REFERENCES gl_parties(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_payment_account_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_payment_account_id_fkey" FOREIGN KEY (payment_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_posted_journal_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_posted_journal_id_fkey" FOREIGN KEY (posted_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_reversal_journal_id_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_reversal_journal_id_fkey" FOREIGN KEY (reversal_journal_id) REFERENCES gl_journals(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_payments' AND k.conname = 'ap_payments_created_by_fkey') THEN
    ALTER TABLE "public"."ap_payments" ADD CONSTRAINT "ap_payments_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_org_id_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_book_id_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_payment_id_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES ap_payments(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_debit_note_id_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_debit_note_id_fkey" FOREIGN KEY (debit_note_id) REFERENCES ap_documents(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_document_id_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_document_id_fkey" FOREIGN KEY (document_id) REFERENCES ap_documents(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_allocations' AND k.conname = 'ap_allocations_created_by_fkey') THEN
    ALTER TABLE "public"."ap_allocations" ADD CONSTRAINT "ap_allocations_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_org_id_fkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_book_id_fkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_payment_id_fkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES ap_payments(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_document_id_fkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_document_id_fkey" FOREIGN KEY (document_id) REFERENCES ap_documents(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'ap_withholding' AND k.conname = 'ap_withholding_gl_account_id_fkey') THEN
    ALTER TABLE "public"."ap_withholding" ADD CONSTRAINT "ap_withholding_gl_account_id_fkey" FOREIGN KEY (gl_account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_org_id_fkey') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_book_id_fkey') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_profiles' AND k.conname = 'bank_profiles_account_id_fkey') THEN
    ALTER TABLE "public"."bank_profiles" ADD CONSTRAINT "bank_profiles_account_id_fkey" FOREIGN KEY (account_id) REFERENCES gl_accounts(id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_org_id_fkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_book_id_fkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_bank_profile_id_fkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_bank_profile_id_fkey" FOREIGN KEY (bank_profile_id) REFERENCES bank_profiles(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_reconciled_by_fkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_reconciled_by_fkey" FOREIGN KEY (reconciled_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statements' AND k.conname = 'bank_statements_imported_by_fkey') THEN
    ALTER TABLE "public"."bank_statements" ADD CONSTRAINT "bank_statements_imported_by_fkey" FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_org_id_fkey') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_statement_lines' AND k.conname = 'bank_statement_lines_statement_id_fkey') THEN
    ALTER TABLE "public"."bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_fkey" FOREIGN KEY (statement_id) REFERENCES bank_statements(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_org_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_book_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_statement_line_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_statement_line_id_fkey" FOREIGN KEY (statement_line_id) REFERENCES bank_statement_lines(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_receipt_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_receipt_id_fkey" FOREIGN KEY (receipt_id) REFERENCES ar_receipts(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_payment_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES ap_payments(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_journal_id_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_journal_id_fkey" FOREIGN KEY (journal_id) REFERENCES gl_journals(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bank_matches' AND k.conname = 'bank_matches_matched_by_fkey') THEN
    ALTER TABLE "public"."bank_matches" ADD CONSTRAINT "bank_matches_matched_by_fkey" FOREIGN KEY (matched_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_org_id_fkey') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_compliance' AND k.conname = 'gl_document_compliance_book_id_fkey') THEN
    ALTER TABLE "public"."gl_document_compliance" ADD CONSTRAINT "gl_document_compliance_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_org_id_fkey') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_posted_journal_id_fkey') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey" FOREIGN KEY (posted_journal_id) REFERENCES gl_journals(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_cash_account_id_fkey') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey" FOREIGN KEY (cash_account_id) REFERENCES gl_accounts(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_created_by_fkey') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_created_by_fkey" FOREIGN KEY (created_by) REFERENCES users(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_reimbursement_batches' AND k.conname = 'fin_reimbursement_batches_approved_by_fkey') THEN
    ALTER TABLE "public"."fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_approved_by_fkey" FOREIGN KEY (approved_by) REFERENCES users(id);
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_org_id_fkey') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'fin_expense_policies' AND k.conname = 'fin_expense_policies_category_id_fkey') THEN
    ALTER TABLE "public"."fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_category_id_fkey" FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'inv_import_rows_org_id_fk') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "inv_import_rows_org_id_fk" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_import_rows' AND k.conname = 'fk_inv_import_rows_job_id_org') THEN
    ALTER TABLE "public"."inv_import_rows" ADD CONSTRAINT "fk_inv_import_rows_job_id_org" FOREIGN KEY (org_id, job_id) REFERENCES inv_import_jobs(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_org_id_fkey') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_book_id_fkey') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_book_id_fkey" FOREIGN KEY (book_id) REFERENCES gl_books(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gl_document_attachments' AND k.conname = 'gl_document_attachments_uploaded_by_fkey') THEN
    ALTER TABLE "public"."gl_document_attachments" ADD CONSTRAINT "gl_document_attachments_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analyses' AND k.conname = 'fk_crm_call_analyses_org') THEN
    ALTER TABLE "public"."crm_call_analyses" ADD CONSTRAINT "fk_crm_call_analyses_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_releases' AND k.conname = 'fk_crm_call_analysis_releases_org') THEN
    ALTER TABLE "public"."crm_call_analysis_releases" ADD CONSTRAINT "fk_crm_call_analysis_releases_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_recording_consent' AND k.conname = 'fk_crm_call_recording_consent_org') THEN
    ALTER TABLE "public"."crm_call_recording_consent" ADD CONSTRAINT "fk_crm_call_recording_consent_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_call_analysis_refusals' AND k.conname = 'fk_crm_call_analysis_refusals_org') THEN
    ALTER TABLE "public"."crm_call_analysis_refusals" ADD CONSTRAINT "fk_crm_call_analysis_refusals_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'fk_crm_commission_plans_org') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "fk_crm_commission_plans_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plans' AND k.conname = 'fk_crm_commission_plans_created_by') THEN
    ALTER TABLE "public"."crm_commission_plans" ADD CONSTRAINT "fk_crm_commission_plans_created_by" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'fk_crm_commission_plan_versions_org') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "fk_crm_commission_plan_versions_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'fk_crm_commission_plan_versions_plan') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "fk_crm_commission_plan_versions_plan" FOREIGN KEY (plan_id) REFERENCES crm_commission_plans(plan_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND k.conname = 'fk_crm_commission_plan_versions_creator') THEN
    ALTER TABLE "public"."crm_commission_plan_versions" ADD CONSTRAINT "fk_crm_commission_plan_versions_creator" FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'fk_crm_commission_assignments_org') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "fk_crm_commission_assignments_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'fk_crm_commission_assignments_plan') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "fk_crm_commission_assignments_plan" FOREIGN KEY (plan_id) REFERENCES crm_commission_plans(plan_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_assignments' AND k.conname = 'fk_crm_commission_assignments_user') THEN
    ALTER TABLE "public"."crm_commission_assignments" ADD CONSTRAINT "fk_crm_commission_assignments_user" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'fk_crm_commission_earnings_org') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "fk_crm_commission_earnings_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'fk_crm_commission_earnings_plan') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "fk_crm_commission_earnings_plan" FOREIGN KEY (plan_id) REFERENCES crm_commission_plans(plan_id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'fk_crm_commission_earnings_version') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "fk_crm_commission_earnings_version" FOREIGN KEY (plan_version_id) REFERENCES crm_commission_plan_versions(plan_version_id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'fk_crm_commission_earnings_user') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "fk_crm_commission_earnings_user" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND k.conname = 'fk_crm_commission_earnings_approved_by') THEN
    ALTER TABLE "public"."crm_commission_earnings" ADD CONSTRAINT "fk_crm_commission_earnings_approved_by" FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'fk_crm_commission_accrual_parts_earning') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "fk_crm_commission_accrual_parts_earning" FOREIGN KEY (earning_id) REFERENCES crm_commission_earnings(earning_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'fk_crm_commission_accrual_parts_org') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "fk_crm_commission_accrual_parts_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'fk_crm_commission_accrual_parts_user') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "fk_crm_commission_accrual_parts_user" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'fk_crm_commission_accrual_parts_plan') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "fk_crm_commission_accrual_parts_plan" FOREIGN KEY (plan_id) REFERENCES crm_commission_plans(plan_id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND k.conname = 'fk_crm_commission_accrual_parts_version') THEN
    ALTER TABLE "public"."crm_commission_accrual_parts" ADD CONSTRAINT "fk_crm_commission_accrual_parts_version" FOREIGN KEY (plan_version_id) REFERENCES crm_commission_plan_versions(plan_version_id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'fk_crm_commission_accrual_snapshots_org') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "fk_crm_commission_accrual_snapshots_org" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'fk_crm_commission_accrual_snapshots_user') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "fk_crm_commission_accrual_snapshots_user" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_snapshots' AND k.conname = 'fk_crm_commission_accrual_snapshots_plan') THEN
    ALTER TABLE "public"."crm_commission_accrual_snapshots" ADD CONSTRAINT "fk_crm_commission_accrual_snapshots_plan" FOREIGN KEY (plan_id) REFERENCES crm_commission_plans(plan_id) ON DELETE RESTRICT;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'fk_customer_lifecycle_signals_org') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "fk_customer_lifecycle_signals_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'fk_customer_lifecycles_org') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'fk_customer_lifecycles_party') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_party" FOREIGN KEY (organization_id, party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycles' AND k.conname = 'fk_customer_lifecycles_deal') THEN
    ALTER TABLE "public"."customer_lifecycles" ADD CONSTRAINT "fk_customer_lifecycles_deal" FOREIGN KEY (organization_id, source_deal_id) REFERENCES deals(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_signals' AND k.conname = 'fk_customer_lifecycle_signals_lifecycle') THEN
    ALTER TABLE "public"."customer_lifecycle_signals" ADD CONSTRAINT "fk_customer_lifecycle_signals_lifecycle" FOREIGN KEY (organization_id, customer_lifecycle_id) REFERENCES customer_lifecycles(organization_id, customer_lifecycle_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'fk_customer_health_assessments_org') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "fk_customer_health_assessments_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_assessments' AND k.conname = 'fk_customer_health_assessments_party') THEN
    ALTER TABLE "public"."customer_health_assessments" ADD CONSTRAINT "fk_customer_health_assessments_party" FOREIGN KEY (organization_id, party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'fk_customer_health_factors_org') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "fk_customer_health_factors_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_health_factors' AND k.conname = 'fk_customer_health_factors_assessment') THEN
    ALTER TABLE "public"."customer_health_factors" ADD CONSTRAINT "fk_customer_health_factors_assessment" FOREIGN KEY (organization_id, customer_health_assessment_id) REFERENCES customer_health_assessments(organization_id, customer_health_assessment_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'fk_customer_lifecycle_triggers_org') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'fk_customer_lifecycle_triggers_lifecycle') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_lifecycle" FOREIGN KEY (organization_id, customer_lifecycle_id) REFERENCES customer_lifecycles(organization_id, customer_lifecycle_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'fk_customer_lifecycle_triggers_party') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_party" FOREIGN KEY (organization_id, party_id) REFERENCES business_parties(organization_id, party_id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'customer_lifecycle_triggers' AND k.conname = 'fk_customer_lifecycle_triggers_deal') THEN
    ALTER TABLE "public"."customer_lifecycle_triggers" ADD CONSTRAINT "fk_customer_lifecycle_triggers_deal" FOREIGN KEY (organization_id, opportunity_deal_id) REFERENCES deals(org_id, id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_definitions' AND k.conname = 'fk_crm_report_definitions_org') THEN
    ALTER TABLE "public"."crm_report_definitions" ADD CONSTRAINT "fk_crm_report_definitions_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_report_runs' AND k.conname = 'fk_crm_report_runs_org') THEN
    ALTER TABLE "public"."crm_report_runs" ADD CONSTRAINT "fk_crm_report_runs_org" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $repair$;
--> statement-breakpoint
--
-- indexes (232)
--
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_waitlist_token ON public.platform_waitlist USING btree (token_hash) WHERE (token_hash IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_platform_waitlist_admitted ON public.platform_waitlist USING btree (admitted_at DESC NULLS LAST);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscription_payments_provider_ref ON public.subscription_payments USING btree (provider, provider_payment_ref) WHERE (provider_payment_ref IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_payments_provider_ref ON public.platform_payments USING btree (provider, provider_payment_ref) WHERE (provider_payment_ref IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_ref ON public.subscriptions USING btree (provider, provider_subscription_ref);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_relationship_states_party ON public.relationship_states USING btree (organization_id, party_id) WHERE (party_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_relationship_states_deal ON public.relationship_states USING btree (organization_id, deal_id) WHERE (deal_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_participants_party ON public.relationship_participants USING btree (organization_id, party_id) WHERE (party_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_states_awaiting ON public.relationship_states USING btree (organization_id, awaiting_reply_since) WHERE (awaiting_reply_since IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_relationship_participants_identity ON public.relationship_participants USING btree (organization_id, relationship_state_id, identity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_participants_state ON public.relationship_participants USING btree (organization_id, relationship_state_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_relationship_threads_thread ON public.relationship_threads USING btree (organization_id, relationship_state_id, thread_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_threads_state ON public.relationship_threads USING btree (organization_id, relationship_state_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_threads_lookup ON public.relationship_threads USING btree (organization_id, thread_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_customer_party_id ON build.tickets USING btree (org_id, customer_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_onboarding_items_client_party_id ON public.client_onboarding_items USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_opportunities_client_party_id ON public.client_opportunities USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_csat_surveys_client_party_id ON public.csat_surveys USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_sales_orders_client_party_id ON public.inv_sales_orders USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_vendors_client_party_id ON public.inv_vendors USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_client_party_id ON public.invoices USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_purchase_bills_vendor_party_id ON public.purchase_bills USING btree (org_id, vendor_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_tickets_client_party_id ON public.support_tickets USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_vip_clients_client_party_id ON public.support_vip_clients USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_rates_client_party_id ON public.timesheet_rates USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_customer_returns_client_party_id ON public.inv_customer_returns USING btree (org_id, client_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_calendar_events_linked_lead_party_id ON public.calendar_events USING btree (org_id, linked_lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_accounts_lead_party_id ON public.client_accounts USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_org_party_map_party ON public.crm_org_party_map USING btree (organization_id, party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_lead_touchpoints_lead_party_id ON public.crm_lead_touchpoints USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deals_lead_party_id ON public.deals USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_party_id ON public.lead_activities USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_emails_lead_party_id ON public.lead_emails USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_party_id ON public.lead_notes USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead_party_id ON public.lead_tasks USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_survey_participants_lead_party_id ON public.survey_participants USING btree (org_id, lead_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedback_posts_crm_contact_party_id ON build.feedback_posts USING btree (org_id, crm_contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedbucket_submissions_crm_contact_party_id ON build.feedbucket_submissions USING btree (org_id, crm_contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_channel_consent_contact_party_id ON public.crm_contact_channel_consent USING btree (org_id, contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_consent_events_contact_party_id ON public.crm_contact_consent_events USING btree (org_id, contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_contact_party_id ON public.crm_contact_roles USING btree (org_id, contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_deal_stakeholders_contact_party_id ON public.crm_deal_stakeholders USING btree (org_id, contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_survey_participants_contact_party_id ON public.survey_participants USING btree (org_id, contact_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedback_posts_crm_organization_party_id ON build.feedback_posts USING btree (org_id, crm_organization_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedbucket_submissions_crm_organization_party_id ON build.feedbucket_submissions USING btree (org_id, crm_organization_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_customer_org_party_id ON build.tickets USING btree (org_id, customer_org_party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_books_org_status ON public.gl_books USING btree (org_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_books_org_default ON public.gl_books USING btree (org_id) WHERE ((is_default = true) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_book_currencies_book_code ON public.gl_book_currencies USING btree (book_id, currency_code);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_book_currencies_base ON public.gl_book_currencies USING btree (book_id) WHERE (is_base = true);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_book_currencies_org_book ON public.gl_book_currencies USING btree (org_id, book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_fx_rates_book_pair_date ON public.gl_fx_rates USING btree (book_id, from_code, to_code, rate_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_fx_rates_org_book_date ON public.gl_fx_rates USING btree (org_id, book_id, rate_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_accounts_book_code ON public.gl_accounts USING btree (book_id, code) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_accounts_book_system_tag ON public.gl_accounts USING btree (book_id, system_tag) WHERE ((system_tag IS NOT NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_accounts_org_book_type ON public.gl_accounts USING btree (org_id, book_id, account_type) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_accounts_book_cash ON public.gl_accounts USING btree (book_id) WHERE ((is_cash = true) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_accounts_book_parent ON public.gl_accounts USING btree (book_id, parent_account_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_fiscal_years_book_name ON public.gl_fiscal_years USING btree (book_id, name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_fiscal_years_book_start ON public.gl_fiscal_years USING btree (book_id, starts_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_fiscal_years_org_book ON public.gl_fiscal_years USING btree (org_id, book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_periods_fy_sequence ON public.gl_periods USING btree (fiscal_year_id, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_periods_book_start ON public.gl_periods USING btree (book_id, starts_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_periods_book_range ON public.gl_periods USING btree (book_id, starts_on, ends_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_periods_org_book_status ON public.gl_periods USING btree (org_id, book_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_journals_book_idempotency ON public.gl_journals USING btree (book_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journals_source ON public.gl_journals USING btree (book_id, source_type, source_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_journals_book_number ON public.gl_journals USING btree (book_id, journal_number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_journals_reverses ON public.gl_journals USING btree (reverses_journal_id) WHERE (reverses_journal_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_journals_reversed_by ON public.gl_journals USING btree (reversed_by_journal_id) WHERE (reversed_by_journal_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journals_book_date ON public.gl_journals USING btree (book_id, journal_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journals_org_book_date ON public.gl_journals USING btree (org_id, book_id, journal_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journals_period ON public.gl_journals USING btree (period_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_journal_lines_journal_line_no ON public.gl_journal_lines USING btree (journal_id, line_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_book_account ON public.gl_journal_lines USING btree (book_id, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_org_book_account ON public.gl_journal_lines USING btree (org_id, book_id, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_journal ON public.gl_journal_lines USING btree (journal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_book_party ON public.gl_journal_lines USING btree (book_id, party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_book_tax_code ON public.gl_journal_lines USING btree (book_id, tax_code_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_book_project ON public.gl_journal_lines USING btree (book_id, dimension_project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_book_branch ON public.gl_journal_lines USING btree (book_id, dimension_branch_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subprocessors_name ON public.subprocessors USING btree (name);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_document_sequences_book_kind_fy ON public.gl_document_sequences USING btree (book_id, kind, fiscal_year_id) WHERE (fiscal_year_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_document_sequences_book_kind ON public.gl_document_sequences USING btree (book_id, kind) WHERE (fiscal_year_id IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_document_sequences_org_book ON public.gl_document_sequences USING btree (org_id, book_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subprocessors_effective ON public.subprocessors USING btree (effective_from);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subprocessor_subscribers_email ON public.subprocessor_subscribers USING btree (email);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subprocessor_subscribers_active ON public.subprocessor_subscribers USING btree (unsubscribed_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_codes_book_code ON public.tax_codes USING btree (book_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_codes_book_active ON public.tax_codes USING btree (book_id, is_active);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_rates_code_component_from ON public.tax_rates USING btree (tax_code_id, component, effective_from);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_rates_code_window ON public.tax_rates USING btree (tax_code_id, effective_from, effective_to);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_registrations_book ON public.tax_registrations USING btree (book_id, regime);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_registrations_party ON public.tax_registrations USING btree (party_id, regime);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_registrations_book_primary ON public.tax_registrations USING btree (book_id, regime) WHERE ((is_primary = true) AND (book_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_gl_map_book_role_component ON public.tax_gl_map USING btree (book_id, gl_role, component);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_gl_map_book ON public.tax_gl_map USING btree (book_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subject_requests_email ON public.subject_requests USING btree (subject_email, requested_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subject_requests_due ON public.subject_requests USING btree (due_by);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_document_lines_document ON public.tax_document_lines USING btree (book_id, document_type, document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_document_lines_book_role ON public.tax_document_lines USING btree (book_id, gl_role, component);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_document_lines_code ON public.tax_document_lines USING btree (book_id, tax_code_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_deal_forecast_models_active ON public.crm_deal_forecast_models USING btree (organization_id) WHERE (status = 'active'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_deal_forecast_models_org_trained ON public.crm_deal_forecast_models USING btree (organization_id, trained_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_parties_book_role ON public.gl_parties USING btree (book_id, role) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_parties_org_book ON public.gl_parties USING btree (org_id, book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_documents_book_number ON public.ar_documents USING btree (book_id, document_number) WHERE (document_number IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_documents_journal ON public.ar_documents USING btree (posted_journal_id) WHERE (posted_journal_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_documents_book_status ON public.ar_documents USING btree (book_id, status, issue_date) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_documents_book_party_open ON public.ar_documents USING btree (book_id, party_id, due_date) WHERE ((status = ANY (ARRAY['POSTED'::acct_document_status, 'PARTIALLY_PAID'::acct_document_status])) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_documents_org_book ON public.ar_documents USING btree (org_id, book_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_documents_gstr ON public.ar_documents USING btree (book_id, gstr_period);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_deal_forecast_scores_deal ON public.crm_deal_forecast_scores USING btree (organization_id, deal_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_document_lines_no ON public.ar_document_lines USING btree (document_id, line_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_document_lines_document ON public.ar_document_lines USING btree (document_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_receipts_book_number ON public.ar_receipts USING btree (book_id, receipt_number) WHERE (receipt_number IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_receipts_provider_payment ON public.ar_receipts USING btree (book_id, provider_payment_id) WHERE (provider_payment_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_receipts_book_party ON public.ar_receipts USING btree (book_id, party_id, receipt_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_receipts_book_date ON public.ar_receipts USING btree (book_id, receipt_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_deal_forecast_scores_org_scored ON public.crm_deal_forecast_scores USING btree (organization_id, scored_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_activities_org_deal_created ON public.deal_activities USING btree (org_id, deal_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_allocations_document ON public.ar_allocations USING btree (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_allocations_receipt ON public.ar_allocations USING btree (receipt_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_allocations_credit_note ON public.ar_allocations USING btree (credit_note_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_allocations_receipt_document ON public.ar_allocations USING btree (receipt_id, document_id) WHERE (receipt_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ar_allocations_credit_document ON public.ar_allocations USING btree (credit_note_id, document_id) WHERE (credit_note_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deals_org_stage_closed ON public.deals USING btree (org_id, stage, actual_close_date) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_documents_book_number ON public.ap_documents USING btree (book_id, document_number) WHERE (document_number IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_documents_vendor_number ON public.ap_documents USING btree (book_id, party_id, vendor_document_number) WHERE ((vendor_document_number IS NOT NULL) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_documents_journal ON public.ap_documents USING btree (posted_journal_id) WHERE (posted_journal_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_documents_book_status ON public.ap_documents USING btree (book_id, status, issue_date) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_documents_book_party_open ON public.ap_documents USING btree (book_id, party_id, due_date) WHERE ((status = ANY (ARRAY['POSTED'::acct_document_status, 'PARTIALLY_PAID'::acct_document_status])) AND (deleted_at IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_documents_org_book ON public.ap_documents USING btree (org_id, book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_document_lines_no ON public.ap_document_lines USING btree (document_id, line_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_document_lines_document ON public.ap_document_lines USING btree (document_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_payments_book_number ON public.ap_payments USING btree (book_id, payment_number) WHERE (payment_number IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payments_book_party ON public.ap_payments USING btree (book_id, party_id, payment_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payments_book_date ON public.ap_payments USING btree (book_id, payment_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_allocations_document ON public.ap_allocations USING btree (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_allocations_payment ON public.ap_allocations USING btree (payment_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_allocations_debit_note ON public.ap_allocations USING btree (debit_note_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_allocations_payment_document ON public.ap_allocations USING btree (payment_id, document_id) WHERE (payment_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ap_allocations_debit_document ON public.ap_allocations USING btree (debit_note_id, document_id) WHERE (debit_note_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_withholding_payment ON public.ap_withholding USING btree (payment_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_withholding_book_date ON public.ap_withholding USING btree (book_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_autonomy_repair_policies_class ON public.autonomy_repair_policies USING btree (organization_id, repair_class);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_profiles_account ON public.bank_profiles USING btree (account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_profiles_book ON public.bank_profiles USING btree (book_id, is_active);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_statements_profile_hash ON public.bank_statements USING btree (bank_profile_id, file_hash) WHERE (file_hash IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_statements_profile_period ON public.bank_statements USING btree (bank_profile_id, period_end);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_statements_book ON public.bank_statements USING btree (book_id, period_end);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_statement_lines_no ON public.bank_statement_lines USING btree (statement_id, line_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_statement ON public.bank_statement_lines USING btree (statement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_date ON public.bank_statement_lines USING btree (statement_id, value_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_autonomy_repairs_decision ON public.autonomy_repairs USING btree (organization_id, autonomous_decision_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_autonomy_repairs_class ON public.autonomy_repairs USING btree (organization_id, repair_class, applied_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_autonomy_repairs_party ON public.autonomy_repairs USING btree (organization_id, party_id, applied_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_autonomy_repairs_live ON public.autonomy_repairs USING btree (organization_id, autonomous_decision_id) WHERE (reverted_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_matches_statement_line ON public.bank_matches USING btree (statement_line_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_matches_receipt ON public.bank_matches USING btree (receipt_id) WHERE (receipt_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_matches_payment ON public.bank_matches USING btree (payment_id) WHERE (payment_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_matches_journal ON public.bank_matches USING btree (journal_id) WHERE (journal_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_matches_book ON public.bank_matches USING btree (book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_document_compliance_document ON public.gl_document_compliance USING btree (book_id, document_type, document_id, transport);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_document_compliance_authority ON public.gl_document_compliance USING btree (transport, authority_id) WHERE (authority_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_document_compliance_book_status ON public.gl_document_compliance USING btree (book_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_products_org_live ON public.inv_products USING btree (org_id, id) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_products_org_sku_live ON public.inv_products USING btree (org_id, sku) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_product_variants_org_sku_live ON public.inv_product_variants USING btree (org_id, sku) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_product_variants_org_live ON public.inv_product_variants USING btree (org_id, id) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_outbound_party_sent ON public.crm_outbound_messages USING btree (organization_id, party_id, sent_at) WHERE (status = 'sent'::text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_outbound_org_created ON public.crm_outbound_messages USING btree (organization_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_outbound_decision ON public.crm_outbound_messages USING btree (organization_id, autonomous_decision_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_outbound_track_sent ON public.crm_outbound_messages USING btree (organization_id, track, sent_at) WHERE (status = 'sent'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_outbound_class_stops_live ON public.crm_outbound_class_stops USING btree (organization_id, party_id, outbound_class) WHERE (released_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_outbound_class_stops_party ON public.crm_outbound_class_stops USING btree (organization_id, party_id, stopped_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_sending_domains_org_domain ON public.crm_sending_domains USING btree (organization_id, domain);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_sending_domains_cold ON public.crm_sending_domains USING btree (organization_id) WHERE (purpose = 'cold'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_autonomy_holds_live_outbound ON public.autonomy_holds USING btree (organization_id, outbound_message_id) WHERE (status = 'held'::text);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_product_uom_conversions_org_product_uom ON public.inv_product_uom_conversions USING btree (org_id, product_id, uom_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_variants_barcode_trgm ON public.inv_product_variants USING gin (barcode gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_import_jobs_org_idempotency ON public.inv_import_jobs USING btree (org_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_import_rows_job_status_row ON public.inv_import_rows USING btree (org_id, job_id, status, row_number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_import_rows_job_row ON public.inv_import_rows USING btree (org_id, job_id, row_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_document_attachments_document ON public.gl_document_attachments USING btree (book_id, document_type, document_id) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_document_attachments_org_book ON public.gl_document_attachments USING btree (org_id, book_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_call_recording_consent ON public.crm_call_recording_consent USING btree (organization_id, activity_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_call_analysis_releases ON public.crm_call_analysis_releases USING btree (organization_id, activity_id, analyzer_version);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_call_analyses_hash ON public.crm_call_analyses USING btree (organization_id, transcript_hash, analyzer_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_call_analyses_activity ON public.crm_call_analyses USING btree (organization_id, activity_id, analyzer_version);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_call_analysis_refusals ON public.crm_call_analysis_refusals USING btree (organization_id, activity_id, rule_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_call_analysis_refusals_org ON public.crm_call_analysis_refusals USING btree (organization_id, last_refused_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_plans_org_name ON public.crm_commission_plans USING btree (org_id, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_plans_org ON public.crm_commission_plans USING btree (org_id, retired_on);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_plan_versions_number ON public.crm_commission_plan_versions USING btree (org_id, plan_id, version_number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_plan_versions_effective ON public.crm_commission_plan_versions USING btree (org_id, plan_id, effective_from);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_plan_versions_lookup ON public.crm_commission_plan_versions USING btree (org_id, plan_id, effective_from DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_earnings_status ON public.crm_commission_earnings USING btree (org_id, status, earned_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_earnings_version ON public.crm_commission_earnings USING btree (org_id, plan_version_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_assignments_start ON public.crm_commission_assignments USING btree (org_id, user_id, effective_from);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_assignments_open ON public.crm_commission_assignments USING btree (org_id, user_id) WHERE (effective_to IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_assignments_lookup ON public.crm_commission_assignments USING btree (org_id, user_id, effective_from DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_assignments_plan ON public.crm_commission_assignments USING btree (org_id, plan_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_earnings_source ON public.crm_commission_earnings USING btree (org_id, source_type, source_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_earnings_attainment ON public.crm_commission_earnings USING btree (org_id, user_id, plan_id, earned_on);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_accrual_parts_slot ON public.crm_commission_accrual_parts USING btree (org_id, earning_id, part_index);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_parts_period ON public.crm_commission_accrual_parts USING btree (org_id, user_id, period_start, earned_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_parts_source ON public.crm_commission_accrual_parts USING btree (org_id, source_type, source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_parts_version ON public.crm_commission_accrual_parts USING btree (org_id, plan_version_id, tier_index);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_parts_earning ON public.crm_commission_accrual_parts USING btree (org_id, earning_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_commission_accrual_snapshots_day ON public.crm_commission_accrual_snapshots USING btree (org_id, user_id, plan_id, period_start, as_of_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_snapshots_curve ON public.crm_commission_accrual_snapshots USING btree (org_id, user_id, as_of_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_snapshots_plan ON public.crm_commission_accrual_snapshots USING btree (org_id, plan_id, period_start);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_lifecycles_deal ON public.customer_lifecycles USING btree (organization_id, source_deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycles_renewal ON public.customer_lifecycles USING btree (organization_id, status, renewal_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycles_risk ON public.customer_lifecycles USING btree (organization_id, status, risk_score);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycles_party ON public.customer_lifecycles USING btree (organization_id, party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_signals_lifecycle ON public.customer_lifecycle_signals USING btree (organization_id, customer_lifecycle_id, observed_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_health_factors_key ON public.customer_health_factors USING btree (organization_id, customer_health_assessment_id, factor_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_health_assessments_party ON public.customer_health_assessments USING btree (organization_id, party_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_health_assessments_score ON public.customer_health_assessments USING btree (organization_id, score);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_lifecycle_triggers_term ON public.customer_lifecycle_triggers USING btree (organization_id, customer_lifecycle_id, term_started_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_triggers_fired ON public.customer_lifecycle_triggers USING btree (organization_id, fired_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_lifecycle_triggers_party ON public.customer_lifecycle_triggers USING btree (organization_id, party_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_report_definitions_org_name ON public.crm_report_definitions USING btree (organization_id, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_report_definitions_org ON public.crm_report_definitions USING btree (organization_id, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_report_definitions_org_source ON public.crm_report_definitions USING btree (organization_id, source_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_report_runs_org_created ON public.crm_report_runs USING btree (organization_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_report_runs_org_definition ON public.crm_report_runs USING btree (organization_id, report_definition_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cell_capacity_measurements_cell ON public.cell_capacity_measurements USING btree (cell_id, measured_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cfd_org_entity_project_key ON public.custom_field_definitions USING btree (org_id, entity_type, project_id, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cfd_org_entity_project_active ON public.custom_field_definitions USING btree (org_id, entity_type, project_id, is_active);
--> statement-breakpoint
--
-- triggers (34)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_plan_versions' AND t.tgname = 'trg_crm_commission_plan_versions_seal') THEN
    CREATE TRIGGER trg_crm_commission_plan_versions_seal BEFORE DELETE OR UPDATE ON public.crm_commission_plan_versions FOR EACH ROW EXECUTE FUNCTION crm_commission_plan_version_seal_guard();
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_earnings' AND t.tgname = 'trg_crm_commission_earnings_seal_version') THEN
    CREATE TRIGGER trg_crm_commission_earnings_seal_version AFTER INSERT ON public.crm_commission_earnings FOR EACH ROW EXECUTE FUNCTION crm_commission_seal_version_on_earning();
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'calendar_events' AND t.tgname = 'trg_calendar_events_lead_party') THEN
    CREATE TRIGGER trg_calendar_events_lead_party BEFORE INSERT OR UPDATE OF linked_lead_id ON public.calendar_events FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('linked_lead_id', 'linked_lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_accounts' AND t.tgname = 'trg_client_accounts_lead_party') THEN
    CREATE TRIGGER trg_client_accounts_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.client_accounts FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_lead_touchpoints' AND t.tgname = 'trg_crm_lead_touchpoints_lead_party') THEN
    CREATE TRIGGER trg_crm_lead_touchpoints_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.crm_lead_touchpoints FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'deals' AND t.tgname = 'trg_deals_lead_party') THEN
    CREATE TRIGGER trg_deals_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.deals FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_activities' AND t.tgname = 'trg_lead_activities_lead_party') THEN
    CREATE TRIGGER trg_lead_activities_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_emails' AND t.tgname = 'trg_lead_emails_lead_party') THEN
    CREATE TRIGGER trg_lead_emails_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.lead_emails FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_notes' AND t.tgname = 'trg_lead_notes_lead_party') THEN
    CREATE TRIGGER trg_lead_notes_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.lead_notes FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'lead_tasks' AND t.tgname = 'trg_lead_tasks_lead_party') THEN
    CREATE TRIGGER trg_lead_tasks_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.lead_tasks FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND t.tgname = 'trg_survey_participants_lead_party') THEN
    CREATE TRIGGER trg_survey_participants_lead_party BEFORE INSERT OR UPDATE OF lead_id ON public.survey_participants FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('lead_id', 'lead_party_id', 'org_id', 'lead_party_map', 'lead_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND t.tgname = 'trg_feedback_posts_contact_party') THEN
    CREATE TRIGGER trg_feedback_posts_contact_party BEFORE INSERT OR UPDATE OF crm_contact_id ON build.feedback_posts FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_contact_id', 'crm_contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND t.tgname = 'trg_feedbucket_contact_party') THEN
    CREATE TRIGGER trg_feedbucket_contact_party BEFORE INSERT OR UPDATE OF crm_contact_id ON build.feedbucket_submissions FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_contact_id', 'crm_contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_channel_consent' AND t.tgname = 'trg_contact_channel_consent_party') THEN
    CREATE TRIGGER trg_contact_channel_consent_party BEFORE INSERT OR UPDATE OF contact_id ON public.crm_contact_channel_consent FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_consent_events' AND t.tgname = 'trg_contact_consent_events_party') THEN
    CREATE TRIGGER trg_contact_consent_events_party BEFORE INSERT OR UPDATE OF contact_id ON public.crm_contact_consent_events FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_contact_roles' AND t.tgname = 'trg_contact_roles_party') THEN
    CREATE TRIGGER trg_contact_roles_party BEFORE INSERT OR UPDATE OF contact_id ON public.crm_contact_roles FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_deal_stakeholders' AND t.tgname = 'trg_deal_stakeholders_party') THEN
    CREATE TRIGGER trg_deal_stakeholders_party BEFORE INSERT OR UPDATE OF contact_id ON public.crm_deal_stakeholders FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'survey_participants' AND t.tgname = 'trg_survey_participants_contact_party') THEN
    CREATE TRIGGER trg_survey_participants_contact_party BEFORE INSERT OR UPDATE OF contact_id ON public.survey_participants FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('contact_id', 'contact_party_id', 'org_id', 'contact_party_map', 'contact_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedback_posts' AND t.tgname = 'trg_feedback_posts_org_party') THEN
    CREATE TRIGGER trg_feedback_posts_org_party BEFORE INSERT OR UPDATE OF crm_organization_id ON build.feedback_posts FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_organization_id', 'crm_organization_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'feedbucket_submissions' AND t.tgname = 'trg_feedbucket_org_party') THEN
    CREATE TRIGGER trg_feedbucket_org_party BEFORE INSERT OR UPDATE OF crm_organization_id ON build.feedbucket_submissions FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('crm_organization_id', 'crm_organization_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND t.tgname = 'trg_tickets_org_party') THEN
    CREATE TRIGGER trg_tickets_org_party BEFORE INSERT OR UPDATE OF customer_id ON build.tickets FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('customer_id', 'customer_org_party_id', 'org_id', 'crm_org_party_map', 'crm_organization_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'build' AND c.relname = 'tickets' AND t.tgname = 'trg_tickets_party') THEN
    CREATE TRIGGER trg_tickets_party BEFORE INSERT OR UPDATE OF customer_id ON build.tickets FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('customer_id', 'customer_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_onboarding_items' AND t.tgname = 'trg_client_onboarding_items_party') THEN
    CREATE TRIGGER trg_client_onboarding_items_party BEFORE INSERT OR UPDATE OF client_id ON public.client_onboarding_items FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'client_opportunities' AND t.tgname = 'trg_client_opportunities_party') THEN
    CREATE TRIGGER trg_client_opportunities_party BEFORE INSERT OR UPDATE OF client_id ON public.client_opportunities FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'csat_surveys' AND t.tgname = 'trg_csat_surveys_party') THEN
    CREATE TRIGGER trg_csat_surveys_party BEFORE INSERT OR UPDATE OF client_id ON public.csat_surveys FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_sales_orders' AND t.tgname = 'trg_inv_sales_orders_party') THEN
    CREATE TRIGGER trg_inv_sales_orders_party BEFORE INSERT OR UPDATE OF client_id ON public.inv_sales_orders FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_vendors' AND t.tgname = 'trg_inv_vendors_party') THEN
    CREATE TRIGGER trg_inv_vendors_party BEFORE INSERT OR UPDATE OF client_id ON public.inv_vendors FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'invoices' AND t.tgname = 'trg_invoices_party') THEN
    CREATE TRIGGER trg_invoices_party BEFORE INSERT OR UPDATE OF client_id ON public.invoices FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'purchase_bills' AND t.tgname = 'trg_purchase_bills_party') THEN
    CREATE TRIGGER trg_purchase_bills_party BEFORE INSERT OR UPDATE OF vendor_id ON public.purchase_bills FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('vendor_id', 'vendor_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_tickets' AND t.tgname = 'trg_support_tickets_party') THEN
    CREATE TRIGGER trg_support_tickets_party BEFORE INSERT OR UPDATE OF client_id ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'support_vip_clients' AND t.tgname = 'trg_support_vip_clients_party') THEN
    CREATE TRIGGER trg_support_vip_clients_party BEFORE INSERT OR UPDATE OF client_id ON public.support_vip_clients FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'timesheet_rates' AND t.tgname = 'trg_timesheet_rates_party') THEN
    CREATE TRIGGER trg_timesheet_rates_party BEFORE INSERT OR UPDATE OF client_id ON public.timesheet_rates FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'inv_customer_returns' AND t.tgname = 'trg_inv_customer_returns_party') THEN
    CREATE TRIGGER trg_inv_customer_returns_party BEFORE INSERT OR UPDATE OF client_id ON public.inv_customer_returns FOR EACH ROW EXECUTE FUNCTION derive_party_from_legacy('client_id', 'client_party_id', 'org_id', 'client_party_map', 'client_id');
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'crm_commission_accrual_parts' AND t.tgname = 'trg_crm_commission_accrual_parts_reconcile') THEN
    CREATE CONSTRAINT TRIGGER trg_crm_commission_accrual_parts_reconcile AFTER INSERT OR DELETE OR UPDATE ON public.crm_commission_accrual_parts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_commission_accrual_parts_reconcile();
  END IF;
END $repair$;
--> statement-breakpoint
--
-- row-level security (62)
--
--> statement-breakpoint
ALTER TABLE "public"."relationship_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_books" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_fx_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ap_withholding" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."relationship_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."relationship_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_journals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ar_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ar_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ap_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."bank_matches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_document_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_document_compliance" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ap_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_forecast_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_deal_forecast_models" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."inv_webhook_event_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."autonomy_repair_policies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_fiscal_years" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."autonomy_repairs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."tax_document_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ap_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_outbound_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_outbound_class_stops" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_cold_outbound_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_sending_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."inv_import_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ap_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."bank_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ar_documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_parties" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."ar_allocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_journal_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."tax_registrations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_document_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_org_party_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."subprocessor_subscribers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."tax_gl_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."tax_rates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_call_recording_consent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_call_analysis_releases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_call_analyses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."bank_statement_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."bank_statements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_call_analysis_refusals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_plans" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_plan_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_assignments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_earnings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_accrual_parts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_commission_accrual_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."customer_lifecycles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."customer_lifecycle_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."customer_health_assessments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."customer_health_factors" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."customer_lifecycle_triggers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_report_definitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."crm_report_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "public"."gl_book_currencies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
--
-- tenant isolation policies (62)
--
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'relationship_states' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."relationship_states" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_books' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_books" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_fx_rates' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_fx_rates" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_periods' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_periods" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_withholding' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ap_withholding" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'relationship_threads' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."relationship_threads" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'relationship_participants' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."relationship_participants" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_journals' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_journals" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ar_document_lines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ar_document_lines" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ar_receipts' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ar_receipts" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_payments' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ap_payments" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_matches' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."bank_matches" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_document_attachments' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_document_attachments" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_document_compliance' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_document_compliance" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tax_codes' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."tax_codes" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_document_lines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ap_document_lines" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_deal_forecast_scores' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_deal_forecast_scores" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_deal_forecast_models' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_deal_forecast_models" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_webhook_event_subscriptions' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_webhook_event_subscriptions" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'autonomy_repair_policies' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."autonomy_repair_policies" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_fiscal_years' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_fiscal_years" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'autonomy_repairs' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."autonomy_repairs" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tax_document_lines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."tax_document_lines" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_documents' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ap_documents" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_outbound_messages' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_outbound_messages" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_outbound_class_stops' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_outbound_class_stops" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_cold_outbound_settings' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_cold_outbound_settings" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_sending_domains' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_sending_domains" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inv_import_rows' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."inv_import_rows" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_allocations' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ap_allocations" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_profiles' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."bank_profiles" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ar_documents' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ar_documents" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_parties' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_parties" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_accounts' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_accounts" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ar_allocations' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."ar_allocations" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_journal_lines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_journal_lines" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tax_registrations' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."tax_registrations" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_document_sequences' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_document_sequences" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_org_party_map' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_org_party_map" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'subprocessor_subscribers' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."subprocessor_subscribers" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tax_gl_map' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."tax_gl_map" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tax_rates' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."tax_rates" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_call_recording_consent' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_call_recording_consent" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_call_analysis_releases' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_call_analysis_releases" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_call_analyses' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_call_analyses" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_statement_lines' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."bank_statement_lines" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'bank_statements' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."bank_statements" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_call_analysis_refusals' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_call_analysis_refusals" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_plans' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_plans" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_plan_versions' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_plan_versions" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_assignments' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_assignments" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_earnings' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_earnings" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_accrual_parts' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_accrual_parts" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_commission_accrual_snapshots' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_commission_accrual_snapshots" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_lifecycles' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."customer_lifecycles" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_lifecycle_signals' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."customer_lifecycle_signals" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_health_assessments' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."customer_health_assessments" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_health_factors' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."customer_health_factors" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customer_lifecycle_triggers' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."customer_lifecycle_triggers" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_report_definitions' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_report_definitions" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'crm_report_runs' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."crm_report_runs" AS PERMISSIVE FOR ALL TO "public" USING ((organization_id = app.current_org_id())) WITH CHECK ((organization_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
DO $repair$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gl_book_currencies' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY "tenant_isolation" ON "public"."gl_book_currencies" AS PERMISSIVE FOR ALL TO "public" USING ((org_id = app.current_org_id())) WITH CHECK ((org_id = app.current_org_id()));
  END IF;
END $repair$;
--> statement-breakpoint
--
-- privileges on the tables this file creates (65)
--
--> statement-breakpoint
REVOKE ALL ON "public"."relationship_states" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."relationship_states" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_books" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_books" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_fx_rates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_fx_rates" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_periods" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_periods" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ap_withholding" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ap_withholding" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."relationship_threads" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."relationship_threads" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."relationship_participants" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."relationship_participants" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_journals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_journals" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ar_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ar_document_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ar_receipts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ar_receipts" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ap_payments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ap_payments" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."bank_matches" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."bank_matches" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_document_attachments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_document_attachments" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_document_compliance" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_document_compliance" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."tax_codes" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tax_codes" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."subprocessors" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."subprocessors" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ap_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ap_document_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."subject_requests" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."subject_requests" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_deal_forecast_scores" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_deal_forecast_scores" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_deal_forecast_models" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_deal_forecast_models" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."autonomy_repair_policies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."autonomy_repair_policies" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_fiscal_years" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_fiscal_years" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."autonomy_repairs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."autonomy_repairs" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."tax_document_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tax_document_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_currencies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_currencies" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ap_documents" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ap_documents" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_outbound_messages" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_outbound_messages" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_outbound_class_stops" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_outbound_class_stops" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_cold_outbound_settings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_cold_outbound_settings" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_sending_domains" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_sending_domains" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."inv_import_rows" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."inv_import_rows" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ap_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ap_allocations" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."bank_profiles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."bank_profiles" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ar_documents" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ar_documents" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_parties" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_parties" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_accounts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_accounts" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."ar_allocations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."ar_allocations" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_journal_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_journal_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."tax_registrations" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tax_registrations" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_document_sequences" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_document_sequences" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_org_party_map" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_org_party_map" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."subprocessor_subscribers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."subprocessor_subscribers" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."tax_gl_map" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tax_gl_map" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."tax_rates" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."tax_rates" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_call_recording_consent" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_call_recording_consent" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_call_analysis_releases" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_call_analysis_releases" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_call_analyses" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_call_analyses" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."bank_statement_lines" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."bank_statement_lines" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."bank_statements" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."bank_statements" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_call_analysis_refusals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_call_analysis_refusals" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_plans" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_plans" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_plan_versions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_plan_versions" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_assignments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_assignments" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_earnings" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_earnings" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_accrual_parts" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_accrual_parts" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_commission_accrual_snapshots" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_commission_accrual_snapshots" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."customer_lifecycles" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."customer_lifecycles" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."customer_lifecycle_signals" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."customer_lifecycle_signals" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."customer_health_assessments" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."customer_health_assessments" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."customer_health_factors" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."customer_health_factors" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."customer_lifecycle_triggers" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."customer_lifecycle_triggers" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_report_definitions" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_report_definitions" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."crm_report_runs" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."crm_report_runs" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."gl_book_currencies" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."gl_book_currencies" TO "streamline_app";
--> statement-breakpoint
REVOKE ALL ON "public"."cell_capacity_measurements" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."cell_capacity_measurements" TO "streamline_app";

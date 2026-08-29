-- The enum types and tables that 0619 creates, lifted to the point in the chain where
-- earlier migrations already reference them.
--
-- 0619 closed the END state: a cold build reaches head with differences=0. It did not close
-- the MIDDLE. 0591_tenant_isolation_for_unprotected_tables tries to protect 401 tables and 124
-- of them do not exist yet at that point, because 0619 appends them afterwards. Those 124 are
-- the whole chain-gap count.
--
-- Only enum and table creation is lifted. Constraints, indexes, policies and triggers stay in
-- 0619, because nothing earlier in the chain references them. The CREATE TABLE statements carry
-- no inline REFERENCES, so this extract has no ordering dependency of its own.
--
-- Every statement is idempotent, so 0619 remains a correct no-op after this runs.

SET statement_timeout = 0;
SET lock_timeout = '5s';
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

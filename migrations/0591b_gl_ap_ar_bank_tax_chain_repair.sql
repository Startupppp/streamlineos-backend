-- GL, AP, AR, bank and tax tables missing from the chain at the point 0591 runs.
--
-- Root cause: these 31 tables (ap_*, ar_*, bank_*, gl_*, tax_*, subprocessor_subscribers)
-- and the 22 enum types they depend on were created on the live database via
-- `drizzle-kit push` and never had a corresponding CREATE TABLE migration. The first
-- migration to CREATE these tables is 0489_chain_creates_early (journal idx=370), but
-- 0489 is placed AFTER 0591_tenant_isolation_for_unprotected_tables (idx=323) in the
-- journal. On a cold replay, when 0591 runs and attempts
-- `ALTER TABLE "ap_allocations" ENABLE ROW LEVEL SECURITY`, the table does not yet
-- exist and the statement fails with 42P01.
--
-- This file is the structural fix. It is placed between 0590 (idx=322) and 0591
-- (idx=323) in the journal so a cold bootstrap creates these tables before 0591 runs.
-- Every statement is idempotent (DO blocks with IF NOT EXISTS for types, CREATE TABLE
-- IF NOT EXISTS for tables), so this file is a complete no-op against any database
-- that already holds these objects — including the live production database.
--
-- WATERMARK INTERACTION (read this before changing the `when` value):
--   apply-chain-cold.mjs (the cold bootstrap script) processes journal entries in JSON
--   ARRAY ORDER, not by `when` value. This file is positioned between idx=322 (0590)
--   and idx=323 (0591) in the array, so a cold bootstrap runs it before 0591 regardless
--   of `when`. Drizzle-kit (`pnpm db:migrate`) on PRODUCTION uses `when` to determine
--   what to apply: it skips any journal entry whose `when` <= max applied `when`. This
--   file's `when` (1798000156000) is above the production watermark at the time it was
--   authored, so production will apply it as a normal pending migration. All statements
--   are idempotent (IF NOT EXISTS), so the apply is a no-op and is safe. The ledger
--   check-migration-ledger.mjs correctly shows this migration as PENDING until the
--   orchestrator runs `pnpm db:migrate`. Do NOT lower `when` below the production
--   watermark: a journal entry below the watermark that is not in the applied set is
--   flagged as SKIPPED by check-migration-ledger.mjs and will never apply.
--
-- Only enum and table creation is included. Constraints, indexes, RLS policies and
-- GRANT statements remain in 0591 and 0489 where they were authored. The CREATE TABLE
-- statements carry no inline REFERENCES clauses, so there is no ordering dependency
-- among the tables within this file.
--
-- Mirrors 0767b_inv_table_chain_repair exactly in pattern and rationale; that migration
-- fixed the same class of push-created tables for the inv_* family at idx=639.

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
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'party_role') THEN
    CREATE TYPE "public"."party_role" AS ENUM ('customer', 'vendor', 'both');
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
CREATE TABLE IF NOT EXISTS "public"."gl_book_currencies" (
  "id" text NOT NULL,
  "org_id" text NOT NULL,
  "book_id" text NOT NULL,
  "currency_code" text NOT NULL,
  "is_base" boolean DEFAULT false NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
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
CREATE TABLE IF NOT EXISTS "public"."subprocessor_subscribers" (
  "subprocessor_subscriber_id" text NOT NULL,
  "email" text NOT NULL,
  "organization_id" text,
  "unsubscribed_at" timestamp without time zone,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);

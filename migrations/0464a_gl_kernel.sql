-- Ledger kernel — the accounting bounded context's posting engine.
--
-- Hand-authored rather than generated: `migrations/meta` carries pre-existing
-- snapshot collisions (0210-0220, 0222-0231) that make `drizzle-kit generate`
-- refuse to diff. Every object here matches `db/schema/accounting/gl-kernel.ts`.
--
-- All tables are new, so foreign keys and NOT NULLs are declared inline — the
-- ADD CONSTRAINT ... NOT VALID dance in backend/CLAUDE.md §3 exists for adding
-- constraints to populated tables, and there is nothing to lock here.
--
-- The old `ledger_accounts` / `journal_entries` / `journal_lines` tables are
-- deliberately left in place: finance/, invoices/ and expenses/ still read them.
-- They are dropped in a later migration once nothing references them.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TYPE "public"."gl_account_type" AS ENUM (
  'ASSET', 'CONTRA_ASSET', 'LIABILITY', 'CONTRA_LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'
);
--> statement-breakpoint
CREATE TYPE "public"."gl_period_status" AS ENUM ('OPEN', 'LOCKED');
--> statement-breakpoint
CREATE TYPE "public"."gl_fiscal_year_status" AS ENUM ('OPEN', 'CLOSED');
--> statement-breakpoint
CREATE TYPE "public"."gl_book_status" AS ENUM ('ACTIVE', 'ARCHIVED');
--> statement-breakpoint
CREATE TYPE "public"."gl_journal_source" AS ENUM (
  'manual', 'opening_balance', 'sales_invoice', 'credit_note', 'receipt',
  'purchase_bill', 'debit_note', 'payment', 'bank_fee', 'bank_transfer',
  'payroll_run', 'billing_invoice', 'withholding', 'fx_reval', 'depreciation',
  'stock_move', 'period_close'
);
--> statement-breakpoint
CREATE TYPE "public"."gl_system_tag" AS ENUM (
  'cash', 'bank', 'undeposited', 'ar_control', 'ap_control', 'sales',
  'other_income', 'cogs', 'opex', 'salary', 'equity_capital',
  'retained_earnings', 'current_year_earnings', 'fx_gain', 'fx_loss',
  'rounding', 'vat_input', 'vat_output', 'sales_tax_payable', 'wht_payable',
  'gst_input_cgst', 'gst_input_sgst', 'gst_input_igst', 'gst_input_utgst',
  'gst_input_cess', 'gst_output_cgst', 'gst_output_sgst', 'gst_output_igst',
  'gst_output_utgst', 'gst_output_cess', 'psp_clearing', 'razorpay_clearing',
  'stripe_clearing', 'payment_fees', 'net_pay_clearing', 'statutory_payable',
  'fixed_asset', 'accum_depreciation', 'depreciation_expense',
  'deferred_revenue', 'inventory'
);

--> statement-breakpoint
-- A book is the set of books for one legal entity. v1 creates one per org.
CREATE TABLE "gl_books" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "legal_entity_id" text REFERENCES "legal_entities"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "country_code" text NOT NULL,
  "base_currency" text NOT NULL,
  "localization_pack" text NOT NULL,
  "fiscal_year_start_month" integer DEFAULT 4 NOT NULL,
  "fiscal_year_start_day" integer DEFAULT 1 NOT NULL,
  "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
  "parent_book_id" text REFERENCES "gl_books"("id") ON DELETE set null,
  "is_default" boolean DEFAULT true NOT NULL,
  "status" "gl_book_status" DEFAULT 'ACTIVE' NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_gl_books_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_gl_books_fy_month" CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12),
  CONSTRAINT "ck_gl_books_fy_day" CHECK ("fiscal_year_start_day" BETWEEN 1 AND 28),
  CONSTRAINT "ck_gl_books_base_currency" CHECK ("base_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE INDEX "idx_gl_books_org_status" ON "gl_books" ("org_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_books_org_default" ON "gl_books" ("org_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;

--> statement-breakpoint
-- Global catalog. A currency's scale is a fact about the world, not an org.
CREATE TABLE "gl_currencies" (
  "code" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "minor_units" integer NOT NULL,
  "symbol" text,
  "is_active" boolean DEFAULT true NOT NULL,
  CONSTRAINT "ck_gl_currencies_code" CHECK ("code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ck_gl_currencies_minor_units" CHECK ("minor_units" BETWEEN 0 AND 4)
);

--> statement-breakpoint
CREATE TABLE "gl_book_currencies" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "currency_code" text NOT NULL REFERENCES "gl_currencies"("code") ON DELETE restrict,
  "is_base" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_book_currencies_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_book_currencies_book_code"
  ON "gl_book_currencies" ("book_id", "currency_code");
--> statement-breakpoint
-- Exactly one base currency per book (PRD 11 invariant).
CREATE UNIQUE INDEX "uniq_gl_book_currencies_base"
  ON "gl_book_currencies" ("book_id") WHERE "is_base" = true;
--> statement-breakpoint
CREATE INDEX "idx_gl_book_currencies_org_book" ON "gl_book_currencies" ("org_id", "book_id");

--> statement-breakpoint
-- `rate` multiplies transaction currency into functional currency.
CREATE TABLE "gl_fx_rates" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "from_code" text NOT NULL,
  "to_code" text NOT NULL,
  "rate_date" date NOT NULL,
  "rate" numeric(18, 10) NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "captured_at" timestamp DEFAULT now() NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "uniq_gl_fx_rates_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_gl_fx_rates_positive" CHECK ("rate" > 0),
  CONSTRAINT "ck_gl_fx_rates_distinct" CHECK ("from_code" <> "to_code")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_fx_rates_book_pair_date"
  ON "gl_fx_rates" ("book_id", "from_code", "to_code", "rate_date");
--> statement-breakpoint
CREATE INDEX "idx_gl_fx_rates_org_book_date" ON "gl_fx_rates" ("org_id", "book_id", "rate_date");

--> statement-breakpoint
CREATE TABLE "gl_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "account_type" "gl_account_type" NOT NULL,
  "parent_account_id" text REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "is_header" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_cash" boolean DEFAULT false NOT NULL,
  "system_tag" "gl_system_tag",
  "currency_restriction" text,
  "description" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_gl_accounts_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_gl_accounts_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_gl_accounts_header_not_cash" CHECK (NOT ("is_header" AND "is_cash"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_accounts_book_code"
  ON "gl_accounts" ("book_id", "code") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- One account per role per book, so tag resolution is never ambiguous.
CREATE UNIQUE INDEX "uniq_gl_accounts_book_system_tag"
  ON "gl_accounts" ("book_id", "system_tag")
  WHERE "system_tag" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_accounts_org_book_type"
  ON "gl_accounts" ("org_id", "book_id", "account_type") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_accounts_book_cash"
  ON "gl_accounts" ("book_id") WHERE "is_cash" = true AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_accounts_book_parent" ON "gl_accounts" ("book_id", "parent_account_id");

--> statement-breakpoint
CREATE TABLE "gl_fiscal_years" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date NOT NULL,
  "status" "gl_fiscal_year_status" DEFAULT 'OPEN' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_fiscal_years_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_gl_fiscal_years_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_gl_fiscal_years_range" CHECK ("ends_on" > "starts_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_fiscal_years_book_name" ON "gl_fiscal_years" ("book_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_fiscal_years_book_start" ON "gl_fiscal_years" ("book_id", "starts_on");
--> statement-breakpoint
CREATE INDEX "idx_gl_fiscal_years_org_book" ON "gl_fiscal_years" ("org_id", "book_id");

--> statement-breakpoint
CREATE TABLE "gl_periods" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "fiscal_year_id" text NOT NULL REFERENCES "gl_fiscal_years"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date NOT NULL,
  "sequence" integer NOT NULL,
  "status" "gl_period_status" DEFAULT 'OPEN' NOT NULL,
  "locked_by" text REFERENCES "users"("id") ON DELETE set null,
  "locked_at" timestamp,
  "lock_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_periods_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_gl_periods_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_gl_periods_range" CHECK ("ends_on" >= "starts_on")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_periods_fy_sequence" ON "gl_periods" ("fiscal_year_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_periods_book_start" ON "gl_periods" ("book_id", "starts_on");
--> statement-breakpoint
-- The date -> period lookup runs on every single post.
CREATE INDEX "idx_gl_periods_book_range" ON "gl_periods" ("book_id", "starts_on", "ends_on");
--> statement-breakpoint
CREATE INDEX "idx_gl_periods_org_book_status" ON "gl_periods" ("org_id", "book_id", "status");

--> statement-breakpoint
-- Append-only. There is no UPDATE path for business fields and no DELETE path.
CREATE TABLE "gl_journals" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "period_id" text NOT NULL REFERENCES "gl_periods"("id") ON DELETE restrict,
  "journal_number" text NOT NULL,
  "journal_date" date NOT NULL,
  "memo" text,
  "source_type" "gl_journal_source" NOT NULL,
  "source_id" text,
  "idempotency_key" text NOT NULL,
  "reverses_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "reversed_by_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "posted_by_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "posted_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_journals_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_gl_journals_book_id" UNIQUE ("book_id", "id")
);
--> statement-breakpoint
-- Double-submit returns the original journal instead of posting twice.
CREATE UNIQUE INDEX "uniq_gl_journals_book_idempotency"
  ON "gl_journals" ("book_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_journals_book_number" ON "gl_journals" ("book_id", "journal_number");
--> statement-breakpoint
-- A journal is reversed at most once, and reverses at most one.
CREATE UNIQUE INDEX "uniq_gl_journals_reverses"
  ON "gl_journals" ("reverses_journal_id") WHERE "reverses_journal_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_journals_reversed_by"
  ON "gl_journals" ("reversed_by_journal_id") WHERE "reversed_by_journal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_journals_book_date" ON "gl_journals" ("book_id", "journal_date");
--> statement-breakpoint
CREATE INDEX "idx_gl_journals_org_book_date" ON "gl_journals" ("org_id", "book_id", "journal_date");
--> statement-breakpoint
CREATE INDEX "idx_gl_journals_source" ON "gl_journals" ("book_id", "source_type", "source_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journals_period" ON "gl_journals" ("period_id");

--> statement-breakpoint
CREATE TABLE "gl_journal_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "journal_id" text NOT NULL REFERENCES "gl_journals"("id") ON DELETE cascade,
  "line_no" integer NOT NULL,
  "account_id" text NOT NULL REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "debit_minor" bigint DEFAULT 0 NOT NULL,
  "credit_minor" bigint DEFAULT 0 NOT NULL,
  "txn_currency" text NOT NULL,
  "txn_amount_minor" bigint NOT NULL,
  "functional_currency" text NOT NULL,
  "functional_amount_minor" bigint NOT NULL,
  "fx_rate" numeric(18, 10) DEFAULT '1' NOT NULL,
  "fx_rate_id" text REFERENCES "gl_fx_rates"("id") ON DELETE set null,
  "party_id" text,
  "tax_code_id" text,
  "tax_component" text,
  "dimension_branch_id" text REFERENCES "org_units"("id") ON DELETE set null,
  -- `projects` lives in the `build` Postgres schema, not `public`.
  "dimension_project_id" integer REFERENCES "build"."projects"("id") ON DELETE set null,
  "dimension_cost_center_id" text,
  "dimension_values" jsonb,
  "description" text,
  CONSTRAINT "uniq_gl_journal_lines_org_id" UNIQUE ("org_id", "id"),
  -- The kernel's invariants, held by the database as well as the service.
  CONSTRAINT "ck_gl_journal_lines_one_side" CHECK (("debit_minor" = 0) <> ("credit_minor" = 0)),
  CONSTRAINT "ck_gl_journal_lines_non_negative" CHECK ("debit_minor" >= 0 AND "credit_minor" >= 0),
  CONSTRAINT "ck_gl_journal_lines_txn_positive" CHECK ("txn_amount_minor" > 0),
  CONSTRAINT "ck_gl_journal_lines_functional_positive" CHECK ("functional_amount_minor" > 0),
  CONSTRAINT "ck_gl_journal_lines_functional_matches_side"
    CHECK ("functional_amount_minor" = GREATEST("debit_minor", "credit_minor")),
  CONSTRAINT "ck_gl_journal_lines_fx_positive" CHECK ("fx_rate" > 0),
  CONSTRAINT "ck_gl_journal_lines_same_ccy_rate_one"
    CHECK ("txn_currency" <> "functional_currency" OR "fx_rate" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_journal_lines_journal_line_no"
  ON "gl_journal_lines" ("journal_id", "line_no");
--> statement-breakpoint
-- The trial balance and account ledger access path.
CREATE INDEX "idx_gl_journal_lines_book_account" ON "gl_journal_lines" ("book_id", "account_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_org_book_account"
  ON "gl_journal_lines" ("org_id", "book_id", "account_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_journal" ON "gl_journal_lines" ("journal_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_book_party" ON "gl_journal_lines" ("book_id", "party_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_book_tax_code" ON "gl_journal_lines" ("book_id", "tax_code_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_book_project"
  ON "gl_journal_lines" ("book_id", "dimension_project_id");
--> statement-breakpoint
CREATE INDEX "idx_gl_journal_lines_book_branch"
  ON "gl_journal_lines" ("book_id", "dimension_branch_id");

--> statement-breakpoint
-- Numbering for journals and every tax document, incremented atomically.
CREATE TABLE "gl_document_sequences" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "fiscal_year_id" text REFERENCES "gl_fiscal_years"("id") ON DELETE cascade,
  "prefix" text NOT NULL,
  "pattern" text NOT NULL,
  "padding" integer DEFAULT 4 NOT NULL,
  "next_number" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_document_sequences_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_gl_document_sequences_next" CHECK ("next_number" >= 1),
  CONSTRAINT "ck_gl_document_sequences_padding" CHECK ("padding" BETWEEN 1 AND 12)
);
--> statement-breakpoint
-- Two partial uniques, because Postgres treats NULLs as distinct and a plain
-- composite would let a continuous series be created twice.
CREATE UNIQUE INDEX "uniq_gl_document_sequences_book_kind_fy"
  ON "gl_document_sequences" ("book_id", "kind", "fiscal_year_id")
  WHERE "fiscal_year_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_document_sequences_book_kind"
  ON "gl_document_sequences" ("book_id", "kind")
  WHERE "fiscal_year_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_document_sequences_org_book" ON "gl_document_sequences" ("org_id", "book_id");

--> statement-breakpoint
-- ISO 4217 seed. Scales are the standard's, not a preference: JPY has no minor
-- unit, KWD has three. Re-runnable.
INSERT INTO "gl_currencies" ("code", "name", "minor_units", "symbol") VALUES
  ('INR', 'Indian Rupee', 2, '₹'),
  ('USD', 'US Dollar', 2, '$'),
  ('EUR', 'Euro', 2, '€'),
  ('GBP', 'Pound Sterling', 2, '£'),
  ('SGD', 'Singapore Dollar', 2, 'S$'),
  ('AUD', 'Australian Dollar', 2, 'A$'),
  ('CAD', 'Canadian Dollar', 2, 'C$'),
  ('AED', 'UAE Dirham', 2, 'د.إ'),
  ('SAR', 'Saudi Riyal', 2, '﷼'),
  ('QAR', 'Qatari Riyal', 2, '﷼'),
  ('CHF', 'Swiss Franc', 2, 'CHF'),
  ('NZD', 'New Zealand Dollar', 2, 'NZ$'),
  ('ZAR', 'South African Rand', 2, 'R'),
  ('MYR', 'Malaysian Ringgit', 2, 'RM'),
  ('THB', 'Thai Baht', 2, '฿'),
  ('PHP', 'Philippine Peso', 2, '₱'),
  ('IDR', 'Indonesian Rupiah', 2, 'Rp'),
  ('HKD', 'Hong Kong Dollar', 2, 'HK$'),
  ('CNY', 'Chinese Yuan', 2, '¥'),
  ('LKR', 'Sri Lankan Rupee', 2, 'Rs'),
  ('BDT', 'Bangladeshi Taka', 2, '৳'),
  ('NPR', 'Nepalese Rupee', 2, 'Rs'),
  ('SEK', 'Swedish Krona', 2, 'kr'),
  ('NOK', 'Norwegian Krone', 2, 'kr'),
  ('DKK', 'Danish Krone', 2, 'kr'),
  ('PLN', 'Polish Zloty', 2, 'zł'),
  ('CZK', 'Czech Koruna', 2, 'Kč'),
  ('MXN', 'Mexican Peso', 2, '$'),
  ('BRL', 'Brazilian Real', 2, 'R$'),
  ('NGN', 'Nigerian Naira', 2, '₦'),
  ('KES', 'Kenyan Shilling', 2, 'KSh'),
  ('TRY', 'Turkish Lira', 2, '₺'),
  ('ILS', 'Israeli New Shekel', 2, '₪'),
  ('JPY', 'Japanese Yen', 0, '¥'),
  ('KRW', 'South Korean Won', 0, '₩'),
  ('VND', 'Vietnamese Dong', 0, '₫'),
  ('CLP', 'Chilean Peso', 0, '$'),
  ('ISK', 'Icelandic Krona', 0, 'kr'),
  ('UGX', 'Ugandan Shilling', 0, 'USh'),
  ('XAF', 'Central African CFA Franc', 0, 'FCFA'),
  ('XOF', 'West African CFA Franc', 0, 'CFA'),
  ('KWD', 'Kuwaiti Dinar', 3, 'د.ك'),
  ('BHD', 'Bahraini Dinar', 3, '.د.ب'),
  ('OMR', 'Omani Rial', 3, '﷼'),
  ('JOD', 'Jordanian Dinar', 3, 'د.ا'),
  ('TND', 'Tunisian Dinar', 3, 'د.ت')
ON CONFLICT ("code") DO NOTHING;

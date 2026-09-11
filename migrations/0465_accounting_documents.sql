-- Accounting source documents: tax determination, parties, AR, AP, banking and
-- the e-invoicing hooks.
--
-- Hand-authored for the same reason as 0464: `migrations/meta` snapshots stop at
-- 0231 while migrations run to 0464, so `drizzle-kit generate` would diff against
-- a baseline ~230 migrations stale and propose recreating all of it.
--
-- Every table is new. `tax_registrations.party_id` gets its foreign key after
-- `gl_parties` exists, further down.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TYPE "public"."tax_category" AS ENUM (
  'standard', 'reduced', 'super_reduced', 'zero', 'exempt', 'out_of_scope', 'reverse_charge'
);
--> statement-breakpoint
CREATE TYPE "public"."tax_gl_role" AS ENUM (
  'output_payable', 'input_recoverable', 'reverse_charge_output',
  'reverse_charge_input', 'blocked_input', 'withheld'
);
--> statement-breakpoint
CREATE TYPE "public"."tax_supply_nature" AS ENUM (
  'domestic_b2b', 'domestic_b2c', 'export', 'import', 'intra_community',
  'oss_b2c', 'reverse_charge', 'outside_scope'
);
--> statement-breakpoint
CREATE TYPE "public"."tax_regime" AS ENUM (
  'GST_IN', 'VAT_EU', 'VAT_GB', 'VAT_GCC', 'GST_SG', 'GST_AU', 'GST_HST_CA',
  'SALES_TAX_US', 'PAN_IN', 'TAN_IN', 'EIN_US', 'GENERIC'
);
--> statement-breakpoint
CREATE TYPE "public"."tax_registration_owner" AS ENUM ('book', 'party');
--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM ('customer', 'vendor', 'both');
--> statement-breakpoint
CREATE TYPE "public"."ar_document_type" AS ENUM ('INVOICE', 'CREDIT_NOTE');
--> statement-breakpoint
CREATE TYPE "public"."ap_document_type" AS ENUM ('BILL', 'DEBIT_NOTE');
--> statement-breakpoint
CREATE TYPE "public"."acct_document_status" AS ENUM (
  'DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'VOID'
);
--> statement-breakpoint
CREATE TYPE "public"."acct_settlement_status" AS ENUM ('POSTED', 'REVERSED');
--> statement-breakpoint
CREATE TYPE "public"."bank_identifier_scheme" AS ENUM (
  'IFSC_ACCOUNT', 'IBAN', 'ROUTING_ACCOUNT', 'SORT_ACCOUNT', 'BSB_ACCOUNT', 'UPI', 'OTHER'
);
--> statement-breakpoint
CREATE TYPE "public"."bank_statement_source" AS ENUM ('csv', 'manual', 'feed');
--> statement-breakpoint
CREATE TYPE "public"."bank_match_kind" AS ENUM ('receipt', 'payment', 'journal');
--> statement-breakpoint
CREATE TYPE "public"."compliance_transport" AS ENUM (
  'none', 'irp', 'peppol', 'fatoora', 'sdi', 'mtd', 'other'
);
--> statement-breakpoint
CREATE TYPE "public"."compliance_status" AS ENUM (
  'not_required', 'pending', 'submitted', 'accepted', 'rejected', 'cancelled'
);
--> statement-breakpoint
CREATE TYPE "public"."compliance_enforcement" AS ENUM ('off', 'warn', 'block_send', 'block_post');

--> statement-breakpoint
CREATE TABLE "tax_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "pack" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category" "tax_category" DEFAULT 'standard' NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "description" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_tax_codes_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_tax_codes_book_id" UNIQUE ("book_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tax_codes_book_code" ON "tax_codes" ("book_id", "code");
--> statement-breakpoint
CREATE INDEX "idx_tax_codes_book_active" ON "tax_codes" ("book_id", "is_active");

--> statement-breakpoint
-- Dated rows. Determination picks the window containing the document date, so
-- changing a rate tomorrow cannot alter an invoice posted yesterday.
CREATE TABLE "tax_rates" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "tax_code_id" text NOT NULL REFERENCES "tax_codes"("id") ON DELETE cascade,
  "component" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_tax_rates_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_tax_rates_bp" CHECK ("rate_bp" >= 0 AND "rate_bp" <= 100000),
  CONSTRAINT "ck_tax_rates_window" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tax_rates_code_component_from"
  ON "tax_rates" ("tax_code_id", "component", "effective_from");
--> statement-breakpoint
CREATE INDEX "idx_tax_rates_code_window"
  ON "tax_rates" ("tax_code_id", "effective_from", "effective_to");

--> statement-breakpoint
-- Owner is an exclusive arc, not a polymorphic entity_type/entity_id pair.
CREATE TABLE "tax_registrations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "owner_type" "tax_registration_owner" NOT NULL,
  "book_id" text REFERENCES "gl_books"("id") ON DELETE cascade,
  "party_id" text,
  "regime" "tax_regime" NOT NULL,
  "number" text NOT NULL,
  "region" text,
  "country_code" text NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "valid_from" date,
  "valid_to" date,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_tax_registrations_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_tax_registrations_owner_arc" CHECK (
    ("owner_type" = 'book' AND "book_id" IS NOT NULL AND "party_id" IS NULL)
    OR ("owner_type" = 'party' AND "party_id" IS NOT NULL AND "book_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "idx_tax_registrations_book" ON "tax_registrations" ("book_id", "regime");
--> statement-breakpoint
CREATE INDEX "idx_tax_registrations_party" ON "tax_registrations" ("party_id", "regime");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tax_registrations_book_primary"
  ON "tax_registrations" ("book_id", "regime")
  WHERE "is_primary" = true AND "book_id" IS NOT NULL;

--> statement-breakpoint
-- Which account a (role, component) pair posts to. This is what keeps
-- "input CGST" out of the AP service.
CREATE TABLE "tax_gl_map" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "gl_role" "tax_gl_role" NOT NULL,
  "component" text NOT NULL,
  "account_id" text NOT NULL REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_tax_gl_map_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tax_gl_map_book_role_component"
  ON "tax_gl_map" ("book_id", "gl_role", "component");
--> statement-breakpoint
CREATE INDEX "idx_tax_gl_map_book" ON "tax_gl_map" ("book_id");

--> statement-breakpoint
-- The engine's verdict, frozen at post. Reports read these rather than
-- re-determining, so a closed period cannot shift under an edited rate.
CREATE TABLE "tax_document_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "document_line_id" text,
  "tax_code_id" text REFERENCES "tax_codes"("id") ON DELETE restrict,
  "component" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "rate_bp" integer NOT NULL,
  "taxable_minor" bigint NOT NULL,
  "tax_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "gl_role" "tax_gl_role" NOT NULL,
  "recoverable" boolean DEFAULT false NOT NULL,
  "gl_account_id" text REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "raw_result" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_tax_document_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_tax_document_lines_taxable" CHECK ("taxable_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_tax_document_lines_document"
  ON "tax_document_lines" ("book_id", "document_type", "document_id");
--> statement-breakpoint
CREATE INDEX "idx_tax_document_lines_book_role"
  ON "tax_document_lines" ("book_id", "gl_role", "component");
--> statement-breakpoint
CREATE INDEX "idx_tax_document_lines_code" ON "tax_document_lines" ("book_id", "tax_code_id");

--> statement-breakpoint
-- A customer or vendor. `external_refs` points at CRM rather than copying it.
CREATE TABLE "gl_parties" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "role" "party_role" DEFAULT 'customer' NOT NULL,
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
  "default_income_account_id" text REFERENCES "gl_accounts"("id") ON DELETE set null,
  "default_expense_account_id" text REFERENCES "gl_accounts"("id") ON DELETE set null,
  "payment_terms_days" integer DEFAULT 30 NOT NULL,
  "withholding_code" text,
  "notes" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_gl_parties_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_gl_parties_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_gl_parties_currency" CHECK ("default_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ck_gl_parties_terms" CHECK ("payment_terms_days" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_gl_parties_book_role" ON "gl_parties" ("book_id", "role")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_parties_org_book" ON "gl_parties" ("org_id", "book_id");

--> statement-breakpoint
-- Now that gl_parties exists, close the arc's other half.
ALTER TABLE "tax_registrations"
  ADD CONSTRAINT "fk_tax_registrations_party"
  FOREIGN KEY ("party_id") REFERENCES "gl_parties"("id") ON DELETE cascade;

--> statement-breakpoint
-- Invoices and credit notes share a table: identical columns, and a credit note
-- is a signed invoice. Two tables would mean two open-item calculations.
CREATE TABLE "ar_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "party_id" text NOT NULL REFERENCES "gl_parties"("id") ON DELETE restrict,
  "document_type" "ar_document_type" NOT NULL,
  "status" "acct_document_status" DEFAULT 'DRAFT' NOT NULL,
  "document_number" text,
  "issue_date" date NOT NULL,
  "due_date" date,
  "currency" text NOT NULL,
  "fx_rate" numeric(18, 10) DEFAULT '1' NOT NULL,
  "supply_nature" "tax_supply_nature" DEFAULT 'domestic_b2b' NOT NULL,
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
  "original_document_id" text REFERENCES "ar_documents"("id") ON DELETE restrict,
  "posted_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "memo" text,
  "reference" text,
  "irn" text,
  "irn_ack_no" text,
  "irn_ack_at" timestamp,
  "signed_qr" text,
  "irp_status" text,
  "gstr_period" text,
  "ecommerce_gstin" text,
  "export_with_igst" boolean DEFAULT false NOT NULL,
  "crm_deal_id" text,
  "dimension_project_id" integer,
  "posted_by" text REFERENCES "users"("id") ON DELETE set null,
  "posted_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_ar_documents_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_ar_documents_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_ar_documents_amounts" CHECK ("net_minor" >= 0 AND "tax_minor" >= 0 AND "gross_minor" >= 0),
  CONSTRAINT "ck_ar_documents_settled" CHECK ("settled_minor" >= 0 AND "settled_minor" <= "gross_minor"),
  CONSTRAINT "ck_ar_documents_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ck_ar_documents_fx" CHECK ("fx_rate" > 0),
  CONSTRAINT "ck_ar_documents_posted_complete" CHECK (
    "status" = 'DRAFT' OR ("document_number" IS NOT NULL AND "posted_journal_id" IS NOT NULL)
  )
);
--> statement-breakpoint
-- A tax document number is never reused, even after a soft delete.
CREATE UNIQUE INDEX "uniq_ar_documents_book_number"
  ON "ar_documents" ("book_id", "document_number") WHERE "document_number" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ar_documents_journal"
  ON "ar_documents" ("posted_journal_id") WHERE "posted_journal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_ar_documents_book_status"
  ON "ar_documents" ("book_id", "status", "issue_date") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- The aging access path.
CREATE INDEX "idx_ar_documents_book_party_open"
  ON "ar_documents" ("book_id", "party_id", "due_date")
  WHERE "status" IN ('POSTED', 'PARTIALLY_PAID') AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_ar_documents_org_book" ON "ar_documents" ("org_id", "book_id");
--> statement-breakpoint
CREATE INDEX "idx_ar_documents_gstr" ON "ar_documents" ("book_id", "gstr_period");

--> statement-breakpoint
CREATE TABLE "ar_document_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "ar_documents"("id") ON DELETE cascade,
  "line_no" integer NOT NULL,
  "description" text NOT NULL,
  "quantity_milli" bigint DEFAULT 1000 NOT NULL,
  "unit" text,
  "unit_price_minor" bigint DEFAULT 0 NOT NULL,
  "discount_minor" bigint DEFAULT 0 NOT NULL,
  "tax_category" "tax_category" DEFAULT 'standard' NOT NULL,
  "commodity_code" text,
  "forced_tax_code_id" text,
  "forced_tax_reason" text,
  "income_account_id" text REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "line_net_minor" bigint DEFAULT 0 NOT NULL,
  "line_tax_minor" bigint DEFAULT 0 NOT NULL,
  "line_gross_minor" bigint DEFAULT 0 NOT NULL,
  "dimension_project_id" integer,
  "dimension_cost_center_id" text,
  CONSTRAINT "uniq_ar_document_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_ar_document_lines_quantity" CHECK ("quantity_milli" <> 0),
  CONSTRAINT "ck_ar_document_lines_discount" CHECK ("discount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ar_document_lines_no" ON "ar_document_lines" ("document_id", "line_no");
--> statement-breakpoint
CREATE INDEX "idx_ar_document_lines_document" ON "ar_document_lines" ("document_id");

--> statement-breakpoint
CREATE TABLE "ar_receipts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "party_id" text NOT NULL REFERENCES "gl_parties"("id") ON DELETE restrict,
  "receipt_number" text,
  "receipt_date" date NOT NULL,
  "deposit_account_id" text NOT NULL REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "currency" text NOT NULL,
  "fx_rate" numeric(18, 10) DEFAULT '1' NOT NULL,
  "amount_minor" bigint NOT NULL,
  "unapplied_minor" bigint DEFAULT 0 NOT NULL,
  "status" "acct_settlement_status" DEFAULT 'POSTED' NOT NULL,
  "payment_method" text,
  "reference" text,
  "memo" text,
  "provider_payment_id" text,
  "posted_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "reversal_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ar_receipts_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_ar_receipts_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_ar_receipts_amount" CHECK ("amount_minor" > 0),
  CONSTRAINT "ck_ar_receipts_unapplied" CHECK ("unapplied_minor" >= 0 AND "unapplied_minor" <= "amount_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ar_receipts_book_number"
  ON "ar_receipts" ("book_id", "receipt_number") WHERE "receipt_number" IS NOT NULL;
--> statement-breakpoint
-- One receipt per PSP capture.
CREATE UNIQUE INDEX "uniq_ar_receipts_provider_payment"
  ON "ar_receipts" ("book_id", "provider_payment_id") WHERE "provider_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_ar_receipts_book_party" ON "ar_receipts" ("book_id", "party_id", "receipt_date");
--> statement-breakpoint
CREATE INDEX "idx_ar_receipts_book_date" ON "ar_receipts" ("book_id", "receipt_date");

--> statement-breakpoint
-- Aging is derived from these rows, not from a status somebody remembered to set.
CREATE TABLE "ar_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "receipt_id" text REFERENCES "ar_receipts"("id") ON DELETE cascade,
  "credit_note_id" text REFERENCES "ar_documents"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "ar_documents"("id") ON DELETE restrict,
  "amount_minor" bigint NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ar_allocations_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_ar_allocations_amount" CHECK ("amount_minor" > 0),
  CONSTRAINT "ck_ar_allocations_source_arc" CHECK (
    ("receipt_id" IS NOT NULL AND "credit_note_id" IS NULL)
    OR ("receipt_id" IS NULL AND "credit_note_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "idx_ar_allocations_document" ON "ar_allocations" ("document_id");
--> statement-breakpoint
CREATE INDEX "idx_ar_allocations_receipt" ON "ar_allocations" ("receipt_id");
--> statement-breakpoint
CREATE INDEX "idx_ar_allocations_credit_note" ON "ar_allocations" ("credit_note_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ar_allocations_receipt_document"
  ON "ar_allocations" ("receipt_id", "document_id") WHERE "receipt_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ar_allocations_credit_document"
  ON "ar_allocations" ("credit_note_id", "document_id") WHERE "credit_note_id" IS NOT NULL;

--> statement-breakpoint
CREATE TABLE "ap_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "party_id" text NOT NULL REFERENCES "gl_parties"("id") ON DELETE restrict,
  "document_type" "ap_document_type" NOT NULL,
  "status" "acct_document_status" DEFAULT 'DRAFT' NOT NULL,
  "document_number" text,
  "vendor_document_number" text,
  "vendor_document_date" date,
  "issue_date" date NOT NULL,
  "due_date" date,
  "currency" text NOT NULL,
  "fx_rate" numeric(18, 10) DEFAULT '1' NOT NULL,
  "supply_nature" "tax_supply_nature" DEFAULT 'domestic_b2b' NOT NULL,
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
  "original_document_id" text REFERENCES "ap_documents"("id") ON DELETE restrict,
  "posted_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "memo" text,
  "reference" text,
  "gstr_period" text,
  "ims_status" text,
  "dimension_project_id" integer,
  "posted_by" text REFERENCES "users"("id") ON DELETE set null,
  "posted_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "deleted_at" timestamp,
  CONSTRAINT "uniq_ap_documents_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_ap_documents_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_ap_documents_amounts" CHECK ("net_minor" >= 0 AND "tax_minor" >= 0 AND "gross_minor" >= 0),
  CONSTRAINT "ck_ap_documents_settled" CHECK ("settled_minor" >= 0 AND "settled_minor" <= "gross_minor"),
  CONSTRAINT "ck_ap_documents_currency" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ck_ap_documents_fx" CHECK ("fx_rate" > 0),
  CONSTRAINT "ck_ap_documents_posted_complete" CHECK (
    "status" = 'DRAFT' OR ("document_number" IS NOT NULL AND "posted_journal_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_documents_book_number"
  ON "ap_documents" ("book_id", "document_number") WHERE "document_number" IS NOT NULL;
--> statement-breakpoint
-- The same vendor cannot bill the same number twice. Enforced, not warned about.
CREATE UNIQUE INDEX "uniq_ap_documents_vendor_number"
  ON "ap_documents" ("book_id", "party_id", "vendor_document_number")
  WHERE "vendor_document_number" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_documents_journal"
  ON "ap_documents" ("posted_journal_id") WHERE "posted_journal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_ap_documents_book_status"
  ON "ap_documents" ("book_id", "status", "issue_date") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_ap_documents_book_party_open"
  ON "ap_documents" ("book_id", "party_id", "due_date")
  WHERE "status" IN ('POSTED', 'PARTIALLY_PAID') AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "idx_ap_documents_org_book" ON "ap_documents" ("org_id", "book_id");

--> statement-breakpoint
CREATE TABLE "ap_document_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "ap_documents"("id") ON DELETE cascade,
  "line_no" integer NOT NULL,
  "description" text NOT NULL,
  "quantity_milli" bigint DEFAULT 1000 NOT NULL,
  "unit" text,
  "unit_price_minor" bigint DEFAULT 0 NOT NULL,
  "discount_minor" bigint DEFAULT 0 NOT NULL,
  "tax_category" "tax_category" DEFAULT 'standard' NOT NULL,
  "commodity_code" text,
  "forced_tax_code_id" text,
  "forced_tax_reason" text,
  "expense_account_id" text REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "capitalize" boolean DEFAULT false NOT NULL,
  "line_net_minor" bigint DEFAULT 0 NOT NULL,
  "line_tax_minor" bigint DEFAULT 0 NOT NULL,
  "line_gross_minor" bigint DEFAULT 0 NOT NULL,
  "dimension_project_id" integer,
  "dimension_cost_center_id" text,
  CONSTRAINT "uniq_ap_document_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_ap_document_lines_quantity" CHECK ("quantity_milli" <> 0),
  CONSTRAINT "ck_ap_document_lines_discount" CHECK ("discount_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_document_lines_no" ON "ap_document_lines" ("document_id", "line_no");
--> statement-breakpoint
CREATE INDEX "idx_ap_document_lines_document" ON "ap_document_lines" ("document_id");

--> statement-breakpoint
-- gross = what the vendor was owed, withheld = tax retained, net = the bank
-- movement. Keeping all three lets a TDS challan reconcile without recomputing.
CREATE TABLE "ap_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "party_id" text NOT NULL REFERENCES "gl_parties"("id") ON DELETE restrict,
  "payment_number" text,
  "payment_date" date NOT NULL,
  "payment_account_id" text NOT NULL REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "currency" text NOT NULL,
  "fx_rate" numeric(18, 10) DEFAULT '1' NOT NULL,
  "gross_minor" bigint NOT NULL,
  "withheld_minor" bigint DEFAULT 0 NOT NULL,
  "net_paid_minor" bigint NOT NULL,
  "unapplied_minor" bigint DEFAULT 0 NOT NULL,
  "status" "acct_settlement_status" DEFAULT 'POSTED' NOT NULL,
  "payment_method" text,
  "reference" text,
  "memo" text,
  "posted_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "reversal_journal_id" text REFERENCES "gl_journals"("id") ON DELETE restrict,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ap_payments_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "uniq_ap_payments_book_id" UNIQUE ("book_id", "id"),
  CONSTRAINT "ck_ap_payments_gross" CHECK ("gross_minor" > 0),
  CONSTRAINT "ck_ap_payments_withheld" CHECK ("withheld_minor" >= 0 AND "withheld_minor" <= "gross_minor"),
  CONSTRAINT "ck_ap_payments_net" CHECK ("net_paid_minor" = "gross_minor" - "withheld_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_payments_book_number"
  ON "ap_payments" ("book_id", "payment_number") WHERE "payment_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_ap_payments_book_party" ON "ap_payments" ("book_id", "party_id", "payment_date");
--> statement-breakpoint
CREATE INDEX "idx_ap_payments_book_date" ON "ap_payments" ("book_id", "payment_date");

--> statement-breakpoint
CREATE TABLE "ap_allocations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "payment_id" text REFERENCES "ap_payments"("id") ON DELETE cascade,
  "debit_note_id" text REFERENCES "ap_documents"("id") ON DELETE cascade,
  "document_id" text NOT NULL REFERENCES "ap_documents"("id") ON DELETE restrict,
  "amount_minor" bigint NOT NULL,
  "created_by" text REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ap_allocations_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_ap_allocations_amount" CHECK ("amount_minor" > 0),
  CONSTRAINT "ck_ap_allocations_source_arc" CHECK (
    ("payment_id" IS NOT NULL AND "debit_note_id" IS NULL)
    OR ("payment_id" IS NULL AND "debit_note_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "idx_ap_allocations_document" ON "ap_allocations" ("document_id");
--> statement-breakpoint
CREATE INDEX "idx_ap_allocations_payment" ON "ap_allocations" ("payment_id");
--> statement-breakpoint
CREATE INDEX "idx_ap_allocations_debit_note" ON "ap_allocations" ("debit_note_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_allocations_payment_document"
  ON "ap_allocations" ("payment_id", "document_id") WHERE "payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ap_allocations_debit_document"
  ON "ap_allocations" ("debit_note_id", "document_id") WHERE "debit_note_id" IS NOT NULL;

--> statement-breakpoint
-- India TDS or generic WHT. Both the legacy section (194J) and the Income Tax
-- Act 2025 payment code (s393) are stored, because practice still uses both.
CREATE TABLE "ap_withholding" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "payment_id" text NOT NULL REFERENCES "ap_payments"("id") ON DELETE cascade,
  "document_id" text REFERENCES "ap_documents"("id") ON DELETE set null,
  "regime" text DEFAULT 'GENERIC_WHT' NOT NULL,
  "legacy_section" text,
  "payment_code" text,
  "rate_bp" integer NOT NULL,
  "base_minor" bigint NOT NULL,
  "withheld_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "gl_account_id" text REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "remittance_reference" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ap_withholding_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_ap_withholding_base" CHECK ("base_minor" > 0),
  CONSTRAINT "ck_ap_withholding_amount" CHECK ("withheld_minor" >= 0 AND "withheld_minor" <= "base_minor"),
  CONSTRAINT "ck_ap_withholding_rate" CHECK ("rate_bp" >= 0 AND "rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE INDEX "idx_ap_withholding_payment" ON "ap_withholding" ("payment_id");
--> statement-breakpoint
CREATE INDEX "idx_ap_withholding_book_date" ON "ap_withholding" ("book_id", "created_at");

--> statement-breakpoint
-- A bank account IS a GL account with is_cash; this is only its metadata.
CREATE TABLE "bank_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "account_id" text NOT NULL REFERENCES "gl_accounts"("id") ON DELETE restrict,
  "display_name" text NOT NULL,
  "bank_name" text,
  "currency" text NOT NULL,
  "country_code" text NOT NULL,
  "identifier_scheme" "bank_identifier_scheme",
  "identifier_value" text,
  "branch_identifier" text,
  "csv_mapping" jsonb,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_bank_profiles_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_bank_profiles_currency" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_profiles_account" ON "bank_profiles" ("account_id");
--> statement-breakpoint
CREATE INDEX "idx_bank_profiles_book" ON "bank_profiles" ("book_id", "is_active");

--> statement-breakpoint
CREATE TABLE "bank_statements" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "bank_profile_id" text NOT NULL REFERENCES "bank_profiles"("id") ON DELETE cascade,
  "source" "bank_statement_source" DEFAULT 'csv' NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "opening_minor" bigint NOT NULL,
  "closing_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "file_hash" text,
  "file_name" text,
  "reconciled_at" timestamp,
  "reconciled_by" text REFERENCES "users"("id") ON DELETE set null,
  "imported_by" text REFERENCES "users"("id") ON DELETE set null,
  "imported_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_bank_statements_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_bank_statements_period" CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint
-- The same export cannot be imported twice.
CREATE UNIQUE INDEX "uniq_bank_statements_profile_hash"
  ON "bank_statements" ("bank_profile_id", "file_hash") WHERE "file_hash" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_bank_statements_profile_period"
  ON "bank_statements" ("bank_profile_id", "period_end");
--> statement-breakpoint
CREATE INDEX "idx_bank_statements_book" ON "bank_statements" ("book_id", "period_end");

--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "statement_id" text NOT NULL REFERENCES "bank_statements"("id") ON DELETE cascade,
  "line_no" integer NOT NULL,
  "value_date" date NOT NULL,
  "amount_minor" bigint NOT NULL,
  "description" text,
  "bank_reference" text,
  "raw_row" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_bank_statement_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_bank_statement_lines_amount" CHECK ("amount_minor" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_statement_lines_no"
  ON "bank_statement_lines" ("statement_id", "line_no");
--> statement-breakpoint
CREATE INDEX "idx_bank_statement_lines_statement" ON "bank_statement_lines" ("statement_id");
--> statement-breakpoint
CREATE INDEX "idx_bank_statement_lines_date"
  ON "bank_statement_lines" ("statement_id", "value_date");

--> statement-breakpoint
-- Strictly 1:1 in v1: the uniques stop one receipt explaining two bank lines.
CREATE TABLE "bank_matches" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "statement_line_id" text NOT NULL REFERENCES "bank_statement_lines"("id") ON DELETE cascade,
  "kind" "bank_match_kind" NOT NULL,
  "receipt_id" text REFERENCES "ar_receipts"("id") ON DELETE cascade,
  "payment_id" text REFERENCES "ap_payments"("id") ON DELETE cascade,
  "journal_id" text REFERENCES "gl_journals"("id") ON DELETE cascade,
  "matched_by" text REFERENCES "users"("id") ON DELETE set null,
  "matched_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_bank_matches_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "ck_bank_matches_counterpart_arc" CHECK (
    ("kind" = 'receipt' AND "receipt_id" IS NOT NULL AND "payment_id" IS NULL AND "journal_id" IS NULL)
    OR ("kind" = 'payment' AND "payment_id" IS NOT NULL AND "receipt_id" IS NULL AND "journal_id" IS NULL)
    OR ("kind" = 'journal' AND "journal_id" IS NOT NULL AND "receipt_id" IS NULL AND "payment_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_matches_statement_line" ON "bank_matches" ("statement_line_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_matches_receipt" ON "bank_matches" ("receipt_id")
  WHERE "receipt_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_matches_payment" ON "bank_matches" ("payment_id")
  WHERE "payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_bank_matches_journal" ON "bank_matches" ("journal_id")
  WHERE "journal_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_bank_matches_book" ON "bank_matches" ("book_id");

--> statement-breakpoint
-- Fields and status only. No government API is called in v1; posting never
-- blocks on compliance while enforcement is 'off'.
CREATE TABLE "gl_document_compliance" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "book_id" text NOT NULL REFERENCES "gl_books"("id") ON DELETE cascade,
  "document_type" text NOT NULL,
  "document_id" text NOT NULL,
  "transport" "compliance_transport" DEFAULT 'none' NOT NULL,
  "status" "compliance_status" DEFAULT 'not_required' NOT NULL,
  "enforcement_at_post" "compliance_enforcement" DEFAULT 'off' NOT NULL,
  "authority_id" text,
  "ack_no" text,
  "ack_at" timestamp,
  "payload_r2_key" text,
  "qr_r2_key" text,
  "schema_version" text,
  "errors" jsonb,
  "attempt_count" text,
  "last_attempt_at" timestamp,
  "cancelled_at" timestamp,
  "cancel_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_gl_document_compliance_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_document_compliance_document"
  ON "gl_document_compliance" ("book_id", "document_type", "document_id", "transport");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_gl_document_compliance_authority"
  ON "gl_document_compliance" ("transport", "authority_id") WHERE "authority_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_gl_document_compliance_book_status"
  ON "gl_document_compliance" ("book_id", "status");

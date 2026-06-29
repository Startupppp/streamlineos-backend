-- Accounting MVP (Indian SMB): enums, indian_states, ledger_accounts, journal entries/lines,
-- invoice GST columns, invoice_items, clients.gstin
DO $$ BEGIN
  CREATE TYPE "public"."account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."journal_entry_status" AS ENUM('DRAFT', 'POSTED', 'VOID');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "indian_states" (
  "state_code" text PRIMARY KEY NOT NULL,
  "state_name" text NOT NULL,
  "gst_state_code" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "ledger_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "account_type" "account_type" NOT NULL,
  "parent_account_id" integer,
  "is_active" boolean DEFAULT true NOT NULL,
  "description" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_ledger_accounts_org_code" UNIQUE ("org_id", "code")
);

CREATE INDEX IF NOT EXISTS "idx_ledger_accounts_org_type_active" ON "ledger_accounts" ("org_id", "account_type", "is_active");

CREATE TABLE IF NOT EXISTS "journal_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "entry_number" text NOT NULL,
  "entry_date" date NOT NULL,
  "description" text,
  "source_type" text NOT NULL,
  "source_id" text,
  "source_event" text,
  "status" "journal_entry_status" DEFAULT 'POSTED' NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_je_org_number" UNIQUE ("org_id", "entry_number"),
  CONSTRAINT "uniq_je_idempotency" UNIQUE ("org_id", "source_type", "source_id", "source_event")
);

CREATE INDEX IF NOT EXISTS "idx_je_org_date" ON "journal_entries" ("org_id", "entry_date");
CREATE INDEX IF NOT EXISTS "idx_je_org_source" ON "journal_entries" ("org_id", "source_type", "source_id");

CREATE TABLE IF NOT EXISTS "journal_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "entry_id" integer NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
  "account_id" integer NOT NULL REFERENCES "ledger_accounts"("id"),
  "debit" numeric(18, 4) DEFAULT '0' NOT NULL,
  "credit" numeric(18, 4) DEFAULT '0' NOT NULL,
  "description" text,
  "line_order" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_jl_entry" ON "journal_lines" ("entry_id");
CREATE INDEX IF NOT EXISTS "idx_jl_account" ON "journal_lines" ("account_id");

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "place_of_supply" text;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "customer_gstin" text;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "supplier_gstin" text;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "reverse_charge" boolean DEFAULT false NOT NULL;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_inclusive" boolean DEFAULT false NOT NULL;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "cgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "igst_amount" numeric(18, 4) DEFAULT '0' NOT NULL;

CREATE TABLE IF NOT EXISTS "invoice_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "invoice_id" integer NOT NULL REFERENCES "invoices"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "hsn_sac_code" text,
  "quantity" numeric(18, 4) NOT NULL,
  "rate" numeric(18, 4) NOT NULL,
  "gst_rate" numeric(5, 2) NOT NULL,
  "amount" numeric(18, 4) NOT NULL,
  "line_order" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_invoice_items_invoice" ON "invoice_items" ("invoice_id");

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "gstin" text;

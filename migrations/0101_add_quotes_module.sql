-- Quotes & Proposals Module
DO $$ BEGIN
  CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "quotes" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "deal_id" integer REFERENCES "deals"("id") ON DELETE SET NULL,
  "client_id" integer REFERENCES "client_accounts"("id") ON DELETE SET NULL,
  "quote_number" text NOT NULL,
  "subject" text NOT NULL,
  "description" text,
  "status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "total_amount" numeric(15, 2) NOT NULL,
  "tax_amount" numeric(15, 2) DEFAULT '0',
  "discount_amount" numeric(15, 2) DEFAULT '0',
  "net_amount" numeric(15, 2) NOT NULL,
  "valid_until" date NOT NULL,
  "terms_and_conditions" text,
  "created_by_id" text NOT NULL REFERENCES "users"("id"),
  "sent_at" timestamp,
  "accepted_at" timestamp,
  "rejected_at" timestamp,
  "rejection_reason" text,
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "quote_line_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_id" integer NOT NULL REFERENCES "quotes"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "quantity" numeric(10, 2) NOT NULL,
  "unit_price" numeric(15, 2) NOT NULL,
  "amount" numeric(15, 2) NOT NULL,
  "tax_rate" numeric(5, 2) DEFAULT '0',
  "display_order" integer DEFAULT 0,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_quotes_org_status" ON "quotes" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "idx_quotes_deal" ON "quotes" ("deal_id");
CREATE INDEX IF NOT EXISTS "idx_quotes_client" ON "quotes" ("client_id");
CREATE INDEX IF NOT EXISTS "idx_quotes_created_by" ON "quotes" ("created_by_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_quotes_number" ON "quotes" ("org_id", "quote_number");

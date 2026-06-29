-- Pass 19: Purchase bills (AP side of accounting)

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "is_vendor" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "purchase_bills" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "vendor_id" integer REFERENCES "clients"("id"),
  "bill_number" text NOT NULL,
  "vendor_bill_number" text,
  "bill_date" date NOT NULL,
  "due_date" date,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
  "tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "cgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "sgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "igst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "discount" numeric(18, 4) DEFAULT '0' NOT NULL,
  "total" numeric(18, 4) DEFAULT '0' NOT NULL,
  "amount_paid" numeric(18, 4) DEFAULT '0' NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "place_of_supply" text,
  "vendor_gstin" text,
  "supplier_gstin" text,
  "reverse_charge" boolean DEFAULT false NOT NULL,
  "notes" text,
  "expense_account_code" text,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_purchase_bills_org_status" ON "purchase_bills" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "idx_purchase_bills_vendor" ON "purchase_bills" ("vendor_id");
CREATE INDEX IF NOT EXISTS "idx_purchase_bills_due_date" ON "purchase_bills" ("due_date");

CREATE TABLE IF NOT EXISTS "purchase_bill_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "bill_id" integer NOT NULL REFERENCES "purchase_bills"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "hsn_sac_code" text,
  "quantity" numeric(18, 4) NOT NULL,
  "rate" numeric(18, 4) NOT NULL,
  "gst_rate" numeric(5, 2) NOT NULL,
  "amount" numeric(18, 4) NOT NULL,
  "line_order" integer NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_purchase_bill_items_bill" ON "purchase_bill_items" ("bill_id");

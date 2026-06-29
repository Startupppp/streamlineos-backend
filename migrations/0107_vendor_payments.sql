-- Pass 21: Vendor payments (closes AP payment loop)

CREATE TABLE IF NOT EXISTS "vendor_payments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "bill_id" integer NOT NULL REFERENCES "purchase_bills"("id") ON DELETE CASCADE,
  "amount" numeric(12, 2) NOT NULL,
  "payment_date" date NOT NULL,
  "payment_method" text NOT NULL,
  "reference_number" text,
  "notes" text,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_vendor_payments_bill" ON "vendor_payments" ("bill_id");
CREATE INDEX IF NOT EXISTS "idx_vendor_payments_org_date" ON "vendor_payments" ("org_id", "payment_date");

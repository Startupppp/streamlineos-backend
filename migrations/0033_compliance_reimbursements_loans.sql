DO $$ BEGIN CREATE TYPE "ack_status" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'DECLINED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "reimbursement_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "loan_status" AS ENUM ('PENDING', 'APPROVED', 'ACTIVE', 'REPAID', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "policy_acknowledgments" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "document_id" integer NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "status" "ack_status" DEFAULT 'PENDING',
  "acknowledged_at" timestamp,
  "ip_address" text,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_policy_ack_doc" ON "policy_acknowledgments" ("document_id");
CREATE INDEX IF NOT EXISTS "idx_policy_ack_user" ON "policy_acknowledgments" ("user_id");

CREATE TABLE IF NOT EXISTS "reimbursements" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "category" text NOT NULL,
  "amount" decimal NOT NULL,
  "description" text,
  "receipt_url" text,
  "status" "reimbursement_status" DEFAULT 'PENDING',
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "paid_at" timestamp,
  "rejection_reason" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_reimbursements_org" ON "reimbursements" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_reimbursements_user" ON "reimbursements" ("user_id");

CREATE TABLE IF NOT EXISTS "salary_loans" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "amount" decimal NOT NULL,
  "reason" text,
  "emi_amount" decimal,
  "total_emis" integer,
  "paid_emis" integer DEFAULT 0,
  "status" "loan_status" DEFAULT 'PENDING',
  "approved_by" text REFERENCES "users"("id"),
  "approved_at" timestamp,
  "disbursed_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_loans_org" ON "salary_loans" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_loans_user" ON "salary_loans" ("user_id");

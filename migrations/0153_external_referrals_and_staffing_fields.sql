-- External referral portal + staffing commercial fields (PRD 16/17)

CREATE TABLE IF NOT EXISTS "external_referrers" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text,
  "referral_token" text NOT NULL,
  "status" text NOT NULL DEFAULT 'ACTIVE',
  "email_verified_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_external_referrers_org_email" ON "external_referrers" ("org_id", "email");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_external_referrers_token" ON "external_referrers" ("referral_token");

CREATE TABLE IF NOT EXISTS "external_referrals" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "referrer_id" integer NOT NULL REFERENCES "external_referrers"("id") ON DELETE CASCADE,
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "status" text NOT NULL DEFAULT 'SUBMITTED',
  "reward_amount" decimal(12, 2),
  "reward_paid_at" timestamp,
  "ip_address" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_external_referrals_referrer_candidate" ON "external_referrals" ("referrer_id", "candidate_id");
CREATE INDEX IF NOT EXISTS "idx_external_referrals_org" ON "external_referrals" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_external_referrals_candidate" ON "external_referrals" ("candidate_id");

ALTER TABLE "recruitment_vendors"
  ADD COLUMN IF NOT EXISTS "contract_type" text NOT NULL DEFAULT 'CONTINGENCY',
  ADD COLUMN IF NOT EXISTS "sla_days" integer,
  ADD COLUMN IF NOT EXISTS "replacement_guarantee_days" integer,
  ADD COLUMN IF NOT EXISTS "portal_token" text,
  ADD COLUMN IF NOT EXISTS "portal_token_expires_at" timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_recruitment_vendors_portal_token" ON "recruitment_vendors" ("portal_token");

ALTER TABLE "vendor_candidate_submissions"
  ADD COLUMN IF NOT EXISTS "bill_rate" decimal(10, 2),
  ADD COLUMN IF NOT EXISTS "pay_rate" decimal(10, 2),
  ADD COLUMN IF NOT EXISTS "contract_start_date" date,
  ADD COLUMN IF NOT EXISTS "contract_end_date" date;

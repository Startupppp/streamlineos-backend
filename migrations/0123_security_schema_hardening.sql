-- Encrypt bankDetails at rest: change column from jsonb to text.
-- Existing JSON objects are cast to their text representation; the app's
-- decryptBankDetails() function handles both plain JSON strings and
-- enc:v1: prefixed encrypted blobs (backward compatible).
ALTER TABLE "users" ALTER COLUMN "bank_details" TYPE text USING "bank_details"::text;

-- Prevent negative leave balances at the DB level.
ALTER TABLE "leave_balances" ADD CONSTRAINT "chk_leave_balance_non_negative" CHECK ("balance" >= 0);

-- One WFH request per user per date.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_wfh_requests_user_date" ON "wfh_requests" ("user_id", "date");

-- Composite indexes for audit log queries (org-scoped filtering).
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_created" ON "audit_logs" ("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_logs_org_action" ON "audit_logs" ("org_id", "action");

-- Referral enhancements: job posting link and lifecycle status.
ALTER TABLE "candidate_referrals" ADD COLUMN IF NOT EXISTS "job_posting_id" integer REFERENCES "job_postings"("id");
ALTER TABLE "candidate_referrals" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'SUBMITTED';

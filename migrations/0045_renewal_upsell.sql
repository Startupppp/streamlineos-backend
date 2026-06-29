-- Feature CE8: Renewal Pipeline columns
ALTER TABLE "client_accounts" ADD COLUMN IF NOT EXISTS "renewal_stage" text NOT NULL DEFAULT 'upcoming';
ALTER TABLE "client_accounts" ADD COLUMN IF NOT EXISTS "renewal_date" date;
ALTER TABLE "client_accounts" ADD COLUMN IF NOT EXISTS "renewal_notes" text;

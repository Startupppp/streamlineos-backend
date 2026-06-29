-- Referral tracking
CREATE TABLE IF NOT EXISTS "candidate_referrals" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "referred_by" text NOT NULL REFERENCES "users"("id"),
  "relationship" text,
  "notes" text,
  "bonus_eligible" boolean NOT NULL DEFAULT true,
  "bonus_amount" numeric(12,2),
  "bonus_paid_at" timestamp,
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_referrals_candidate" ON "candidate_referrals"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_referrals_referred_by" ON "candidate_referrals"("referred_by");

-- Video interview recordings linked to interviews
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "recording_url" text;
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "recording_platform" text;

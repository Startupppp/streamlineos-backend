-- Candidate offer tracking
CREATE TABLE IF NOT EXISTS "candidate_offers" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "offered_by" text REFERENCES "users"("id"),
  "offer_status" text NOT NULL DEFAULT 'DRAFT',
  -- DRAFT | SENT | VIEWED | ACCEPTED | DECLINED | COUNTERED | EXPIRED
  "offered_salary" decimal,
  "offered_designation" text,
  "joining_date" date,
  "offer_letter_url" text,
  "valid_until" date,
  "notes" text,
  "sent_at" timestamp,
  "viewed_at" timestamp,
  "responded_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX "idx_candidate_offers_candidate" ON "candidate_offers"("candidate_id");
CREATE INDEX "idx_candidate_offers_org" ON "candidate_offers"("org_id");

-- Leave blackout dates
CREATE TABLE IF NOT EXISTS "leave_blackout_dates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "reason" text NOT NULL,
  "applies_to" text DEFAULT 'ALL',
  -- ALL | department:<id> | branch:<id>
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX "idx_leave_blackout_org" ON "leave_blackout_dates"("org_id", "start_date");

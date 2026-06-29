CREATE TABLE IF NOT EXISTS "interview_booking_links" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "token" text NOT NULL UNIQUE,
  "interviewer_ids" jsonb NOT NULL DEFAULT '[]',
  "duration_minutes" integer NOT NULL DEFAULT 60,
  "interview_type" text NOT NULL DEFAULT 'VIDEO',
  "available_slots" jsonb NOT NULL DEFAULT '[]',
  "selected_slot" timestamp,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp NOT NULL,
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "notes" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_booking_links_token" ON "interview_booking_links"("token");
CREATE INDEX IF NOT EXISTS "idx_booking_links_candidate" ON "interview_booking_links"("candidate_id");

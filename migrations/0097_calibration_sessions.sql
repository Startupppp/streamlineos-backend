CREATE TABLE IF NOT EXISTS "calibration_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "candidate_id" integer NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "job_posting_id" integer REFERENCES "job_postings"("id"),
  "scheduled_at" timestamp,
  "status" text NOT NULL DEFAULT 'pending',
  "notes" text,
  "decision" text,
  "participant_ids" jsonb NOT NULL DEFAULT '[]',
  "created_by" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_calibration_sessions_candidate" ON "calibration_sessions"("candidate_id");
CREATE INDEX IF NOT EXISTS "idx_calibration_sessions_org" ON "calibration_sessions"("org_id");

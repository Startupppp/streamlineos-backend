CREATE TABLE IF NOT EXISTS "interview_slas" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "stage" TEXT NOT NULL,
  "max_hours" INTEGER NOT NULL DEFAULT 48,
  "warning_hours" INTEGER NOT NULL DEFAULT 36,
  "created_at" TIMESTAMP DEFAULT NOW(),
  UNIQUE("org_id", "stage")
);

CREATE TABLE IF NOT EXISTS "candidate_sla_tracking" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "candidate_id" INTEGER NOT NULL REFERENCES "candidates"("id") ON DELETE CASCADE,
  "stage" TEXT NOT NULL,
  "entered_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "breached_at" TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'ON_TRACK',
  "updated_at" TIMESTAMP DEFAULT NOW(),
  UNIQUE("candidate_id", "stage")
);

ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "reminders_sent" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "idx_sla_tracking_org_status" ON "candidate_sla_tracking"("org_id", "status");
CREATE INDEX IF NOT EXISTS "idx_sla_tracking_candidate" ON "candidate_sla_tracking"("candidate_id");

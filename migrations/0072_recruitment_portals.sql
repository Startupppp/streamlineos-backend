-- Add external posting IDs to job_postings
ALTER TABLE "job_postings"
  ADD COLUMN IF NOT EXISTS "external_posting_ids" JSONB;

-- Create candidate_sources table for job board integrations
CREATE TABLE IF NOT EXISTS "candidate_sources" (
  "id" SERIAL PRIMARY KEY,
  "org_id" TEXT NOT NULL REFERENCES "organizations"("id"),
  "platform" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "oauth_token" TEXT,
  "meta" JSONB,
  "last_synced_at" TIMESTAMP,
  "last_sync_count" INTEGER DEFAULT 0,
  "created_by" TEXT NOT NULL REFERENCES "users"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_candidate_sources_org" ON "candidate_sources" ("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_candidate_sources_org_platform" ON "candidate_sources" ("org_id", "platform");

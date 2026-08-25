ALTER TABLE "inbox_records"
  ADD COLUMN IF NOT EXISTS "aggregate_type" text,
  ADD COLUMN IF NOT EXISTS "aggregate_id" text;

CREATE INDEX IF NOT EXISTS "idx_inbox_aggregate_version"
  ON "inbox_records" ("organization_id", "consumer_name", "aggregate_type", "aggregate_id", "aggregate_version");

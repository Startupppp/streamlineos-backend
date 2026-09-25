-- Rollback for 1209_kb_events_correlation_id
-- Removes the correlation_id column and its index from kb_events.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "public"."idx_kb_events_org_correlation";

ALTER TABLE "public"."kb_events"
  DROP COLUMN IF EXISTS "correlation_id";

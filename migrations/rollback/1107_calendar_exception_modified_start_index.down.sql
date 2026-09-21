-- Rollback for migration 1107.
-- The forward migration added a partial composite index on calendar_event_exceptions
-- to serve lookups by (org_id, event_id, modified_start). No data is lost.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cal_exc_org_event_modified";

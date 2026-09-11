-- 0991 DOWN — drops the two columns this migration added. Every recorded local_version
-- is lost, so a re-apply restarts every event at 0 and the sync sweep can no longer tell
-- a stale provider echo from a current one until each event is written again.
-- @data-loss

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "calendar_provider_sync_queue" DROP COLUMN IF EXISTS "event_local_version";
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP COLUMN IF EXISTS "local_version";

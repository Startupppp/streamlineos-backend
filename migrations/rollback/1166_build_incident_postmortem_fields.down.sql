-- Rollback for migration 1166.
--
-- Drops the incident postmortem additions: the release link column, the
-- decisions log table, and the follow-up actions table.
--
-- @data-loss: build.project_incidents.release_id, build.incident_decisions,
-- build.incident_follow_up_actions
-- Any release linked to an incident, every recorded decision, and every
-- follow-up action (including its status/owner/due-date history) is lost.
-- The base incident row (title, severity, status, ownerId, rootCause, ...)
-- is untouched.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."incident_follow_up_actions";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."incident_decisions";
--> statement-breakpoint

ALTER TABLE "build"."project_incidents" DROP COLUMN IF EXISTS "release_id";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE t.typname = 'incident_follow_up_status' AND NOT a.attisdropped
  ) THEN
    DROP TYPE IF EXISTS "public"."incident_follow_up_status";
  END IF;
END $$;

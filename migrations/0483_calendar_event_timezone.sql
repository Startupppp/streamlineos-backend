-- 0483_calendar_event_timezone
-- Adds timezone (IANA zone name) to calendar_events and promotes the naive
-- start_date / end_date timestamps to TIMESTAMP WITH TIME ZONE.
--
-- Assumption for existing rows: Neon's server timezone is UTC, so every naive
-- TIMESTAMP value already represents a UTC instant.  The type-change cast is
-- therefore lossless: "2024-01-01 09:00:00" (no zone) becomes
-- "2024-01-01 09:00:00+00" (UTC), the same instant.  All existing events
-- receive timezone = 'UTC' to record that assumption explicitly.

-- OPERATOR WARNING — this migration REWRITES the table.
-- ALTER COLUMN ... TYPE takes an ACCESS EXCLUSIVE lock and rewrites every row,
-- blocking reads and writes for the duration. lock_timeout makes it fail fast
-- rather than queue behind a long reader, so on a large calendar_events it may
-- need a maintenance window and more than one attempt.
--
-- REQUIRED AFTER APPLYING:  VACUUM ANALYZE calendar_events;
-- A rewrite invalidates the planner statistics AND empties the visibility map.
-- Measured elsewhere in this codebase: a rewritten table went 53 -> 201,875
-- blocks until ANALYZE, and a count stayed wrong until VACUUM. Skipping this
-- makes the table look slow for reasons that have nothing to do with the query.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "calendar_events"
  ADD COLUMN "timezone" text NOT NULL DEFAULT 'UTC';

--> statement-breakpoint
ALTER TABLE "calendar_events"
  ALTER COLUMN "start_date" TYPE TIMESTAMP WITH TIME ZONE,
  ALTER COLUMN "end_date" TYPE TIMESTAMP WITH TIME ZONE;

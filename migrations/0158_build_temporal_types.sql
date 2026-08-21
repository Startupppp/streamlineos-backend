-- SCH-007: Promote event timestamps to timestamptz.
-- These columns record WHEN events occurred on a UTC-only server.
-- USING col AT TIME ZONE 'UTC' explicitly reinterprets each stored wall-clock
-- value as UTC, producing an identical instant in timestamptz representation.
--
-- sprints.start_date / end_date are intentionally left as timestamp without
-- time zone: projects-reports.service.ts calls .toISOString() on the Drizzle
-- value, which requires a JS Date object. Converting to the Drizzle `date`
-- type (which returns a string) would cause runtime failures. See SCH-007
-- findings in the refactor brief.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

-- tickets (204 000 rows) ------------------------------------------------------
ALTER TABLE tickets
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ANALYZE tickets;
--> statement-breakpoint

-- ticket_comments (500 000 rows) ----------------------------------------------
ALTER TABLE ticket_comments
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ANALYZE ticket_comments;
--> statement-breakpoint

-- ticket_activity_log (400 000 rows) ------------------------------------------
ALTER TABLE ticket_activity_log
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ANALYZE ticket_activity_log;

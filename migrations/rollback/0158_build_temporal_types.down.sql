-- Rollback for 0158_build_temporal_types
-- Reverts event timestamps from timestamptz back to timestamp without time zone.
-- USING col AT TIME ZONE 'UTC' strips the offset and writes the UTC wall-clock
-- string back, which is the inverse of the forward migration.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE tickets
  ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamp USING updated_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE ticket_comments
  ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamp USING updated_at AT TIME ZONE 'UTC';
--> statement-breakpoint
ALTER TABLE ticket_activity_log
  ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC';

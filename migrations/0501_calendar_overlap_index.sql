-- 0501_calendar_overlap_index
-- Adds idx_calendar_events_org_end_date to support the interval overlap query
-- pattern used by the native source loader and conflict detection (c16-07, c16-08):
--
--   WHERE org_id = $1
--     AND start_date < $range_end        -- covered by idx_calendar_events_org_date
--     AND end_date   > $range_start      -- covered by this new index
--
-- The existing idx_calendar_events_org_date (org_id, start_date) handles the
-- start_date predicate.  Adding a second index on (org_id, end_date) lets the
-- planner use a bitmap AND of both, which efficiently captures long events that
-- begin before the window but end within it.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a migration transaction.
-- The plain form below takes a ShareLock on calendar_events for the duration of
-- the index build.  On a large table, prefer to run the CONCURRENTLY form
-- manually in a maintenance window:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calendar_events_org_end_date
--     ON calendar_events (org_id, end_date);
--
-- Precedent: 0374_build_partial_indexes.sql uses the same non-concurrent pattern.
--
-- REQUIRED AFTER APPLYING:  VACUUM ANALYZE calendar_events;
-- The planner needs fresh statistics to choose the bitmap AND path.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_calendar_events_org_end_date
  ON calendar_events (org_id, end_date);

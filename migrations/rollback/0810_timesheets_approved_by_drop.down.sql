-- Rollback for 0810_timesheets_approved_by_drop
--
-- IRRECOVERABLE DATA LOSS WARNING:
-- Migration 0810 dropped approved_by (users.id FK) from timesheets and
-- timesheet_periods after the companion approved_by_membership_id column
-- was fully backfilled. The original user-id text values are permanently
-- gone without a point-in-time restore. This rollback recreates the columns
-- as nullable text so the schema matches the pre-0810 shape. Original values
-- cannot be recovered from this rollback alone.

SET lock_timeout = '5s';

-- timesheets: restore approved_by as nullable text
ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS approved_by text;

-- timesheet_periods: restore approved_by as nullable text
ALTER TABLE timesheet_periods
  ADD COLUMN IF NOT EXISTS approved_by text;

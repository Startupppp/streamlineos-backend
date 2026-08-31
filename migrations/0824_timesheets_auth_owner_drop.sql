-- 0824_timesheets_auth_owner_drop
-- Drop five AUTHORITY legacy users.id owner columns from timesheets now that:
--   • companion user_membership_id exists and FK is validated (migration 0820)
--   • all service read paths filter by user_membership_id
--   • all service write paths emit user_membership_id from actingMembershipId(u.principal)
--
-- Columns dropped:
--   timesheets            user_id  (AUTH — primary owner)
--   timesheet_exceptions  user_id  (AUTH — exception owner)
--   timesheet_periods     user_id  (AUTH — period owner)
--   timesheet_rates       user_id  (AUTH — rate assignee)
--   timer_sessions        user_id  (AUTH — session owner)

SET lock_timeout = '5s';
--> statement-breakpoint

-- Pre-flight: companion FKs must be validated
DO $$
DECLARE
  unvalidated text;
BEGIN
  SELECT string_agg(conname, ', ') INTO unvalidated
  FROM pg_constraint
  WHERE conname IN (
    'fk_timesheets_user_membership',
    'fk_timesheet_exceptions_user_membership',
    'fk_timesheet_periods_user_membership',
    'fk_timesheet_rates_user_membership',
    'fk_timer_sessions_user_membership'
  )
    AND contype = 'f'
    AND NOT convalidated;

  IF unvalidated IS NOT NULL THEN
    RAISE EXCEPTION '0824: companion FKs not yet validated — run 0820 first: %', unvalidated;
  END IF;
END $$;
--> statement-breakpoint

-- Safety: for AUTH columns, unmapped rows (departed members) must be investigated.
-- The below checks are non-blocking but the counts are surfaced via RAISE NOTICE
-- so the DBA can inspect them before confirming this migration is correct.
DO $$
DECLARE
  ts_unmapped bigint;
  te_unmapped bigint;
  tp_unmapped bigint;
  tr_unmapped bigint;
  tm_unmapped bigint;
BEGIN
  SELECT count(*) INTO ts_unmapped FROM timesheets
    WHERE user_id IS NOT NULL AND user_membership_id IS NULL;
  SELECT count(*) INTO te_unmapped FROM timesheet_exceptions
    WHERE user_id IS NOT NULL AND user_membership_id IS NULL;
  SELECT count(*) INTO tp_unmapped FROM timesheet_periods
    WHERE user_id IS NOT NULL AND user_membership_id IS NULL;
  SELECT count(*) INTO tr_unmapped FROM timesheet_rates
    WHERE user_id IS NOT NULL AND user_membership_id IS NULL;
  SELECT count(*) INTO tm_unmapped FROM timer_sessions
    WHERE user_id IS NOT NULL AND user_membership_id IS NULL;

  IF ts_unmapped + te_unmapped + tp_unmapped + tr_unmapped + tm_unmapped > 0 THEN
    RAISE EXCEPTION
      '0824 safety: unmapped AUTH rows remain (timesheets=%, exceptions=%, periods=%, rates=%, timer=%). '
      'Investigate departed members before dropping these columns. '
      'Run backfill manually for any re-joined members, or null their user_id if the record belongs to a departed member with no session.',
      ts_unmapped, te_unmapped, tp_unmapped, tr_unmapped, tm_unmapped;
  END IF;
END $$;
--> statement-breakpoint

-- timesheets.user_id
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS timesheets_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheets DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- timesheet_exceptions.user_id
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS timesheet_exceptions_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- timesheet_periods.user_id
ALTER TABLE timesheet_periods DROP CONSTRAINT IF EXISTS timesheet_periods_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_periods DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- timesheet_rates.user_id
ALTER TABLE timesheet_rates DROP CONSTRAINT IF EXISTS timesheet_rates_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_rates DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- timer_sessions.user_id
ALTER TABLE timer_sessions DROP CONSTRAINT IF EXISTS timer_sessions_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timer_sessions DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- Recreate indexes that referenced the dropped user_id columns
-- (DROP COLUMN auto-drops any index that includes the dropped column)

-- timesheets: replace (org_id, user_id, date) and partial unique on work_log
CREATE INDEX IF NOT EXISTS idx_timesheets_org_user_membership_date
  ON timesheets (org_id, user_membership_id, date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_timesheets_work_log
  ON timesheets (org_id, user_membership_id, date)
  WHERE ticket_id IS NULL;
--> statement-breakpoint

-- timesheet_exceptions: replace (org_id, user_id)
CREATE INDEX IF NOT EXISTS idx_ts_exceptions_user_membership
  ON timesheet_exceptions (org_id, user_membership_id);
--> statement-breakpoint

-- timesheet_periods: replace (org_id, user_id, period_start) and unique
CREATE UNIQUE INDEX IF NOT EXISTS uniq_timesheet_periods_user_membership_range
  ON timesheet_periods (org_id, user_membership_id, period_start, period_end);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_user_membership_start
  ON timesheet_periods (org_id, user_membership_id, period_start);
--> statement-breakpoint

-- timer_sessions: replace (org_id, user_id, status)
CREATE INDEX IF NOT EXISTS idx_timer_sessions_user_membership_status
  ON timer_sessions (org_id, user_membership_id, status);
--> statement-breakpoint

-- Post-flight
DO $$
DECLARE
  still_present text;
BEGIN
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO still_present
  FROM (VALUES
    ('timesheets', 'user_id'),
    ('timesheet_exceptions', 'user_id'),
    ('timesheet_periods', 'user_id'),
    ('timesheet_rates', 'user_id'),
    ('timer_sessions', 'user_id')
  ) AS t(tbl, col)
  WHERE EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF still_present IS NOT NULL THEN
    RAISE EXCEPTION '0824: legacy user_id columns still present: %', still_present;
  END IF;
END $$;

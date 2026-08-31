-- 0810_timesheets_approved_by_drop
-- Cutover: drop the legacy approved_by (users.id) columns from timesheets and
-- timesheet_periods now that all readers and writers use approved_by_membership_id.
-- Companion columns were added + backfilled + validated in 0647.
-- Code was updated to read via LEFT JOIN on approved_by_membership_id → organization_members.
SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  unmapped bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM timesheets WHERE approved_by IS NOT NULL AND approved_by_membership_id IS NULL)
  + (SELECT count(*) FROM timesheet_periods WHERE approved_by IS NOT NULL AND approved_by_membership_id IS NULL)
  INTO unmapped;
  IF unmapped > 0 THEN
    RAISE EXCEPTION '0810 safety check: % row(s) have approved_by set but no approved_by_membership_id — backfill incomplete', unmapped;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE timesheets DROP COLUMN IF EXISTS approved_by;
--> statement-breakpoint
ALTER TABLE timesheet_periods DROP COLUMN IF EXISTS approved_by;

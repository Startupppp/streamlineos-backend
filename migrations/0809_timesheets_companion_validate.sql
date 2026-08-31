-- 0809_timesheets_companion_validate
-- Add membership-id companions for timesheet_periods.current_approver_id and
-- timesheet_exceptions.owner_user_id, backfill, add FK NOT VALID, then validate.
-- Constraints from 0700/0701 are already validated; this covers the remaining columns.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE timesheet_periods ADD COLUMN IF NOT EXISTS current_approver_membership_id integer;
--> statement-breakpoint
UPDATE timesheet_periods t
SET current_approver_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.current_approver_id
  AND t.current_approver_id IS NOT NULL
  AND t.current_approver_membership_id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheet_periods_current_approver_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheet_periods
      ADD CONSTRAINT fk_timesheet_periods_current_approver_membership
      FOREIGN KEY (org_id, current_approver_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (current_approver_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE timesheet_periods VALIDATE CONSTRAINT fk_timesheet_periods_current_approver_membership;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_current_approver_membership
  ON timesheet_periods (org_id, current_approver_membership_id);
--> statement-breakpoint
ALTER TABLE timesheet_exceptions ADD COLUMN IF NOT EXISTS owner_membership_id integer;
--> statement-breakpoint
UPDATE timesheet_exceptions t
SET owner_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.owner_user_id
  AND t.owner_user_id IS NOT NULL
  AND t.owner_membership_id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_timesheet_exceptions_owner_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE timesheet_exceptions
      ADD CONSTRAINT fk_timesheet_exceptions_owner_membership
      FOREIGN KEY (org_id, owner_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (owner_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions VALIDATE CONSTRAINT fk_timesheet_exceptions_owner_membership;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_exceptions_org_owner_membership
  ON timesheet_exceptions (org_id, owner_membership_id);

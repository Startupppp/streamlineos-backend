SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE timesheets t
SET locked_by_membership_id = om.id
FROM organization_members om
WHERE om.user_id = t.locked_by
  AND om.org_id = t.org_id
  AND t.locked_by IS NOT NULL
  AND t.locked_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exports t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.user_id = t.created_by
  AND om.org_id = t.org_id
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exports t
SET ack_by_membership_id = om.id
FROM organization_members om
WHERE om.user_id = t.ack_by
  AND om.org_id = t.org_id
  AND t.ack_by IS NOT NULL
  AND t.ack_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_settings_history t
SET changed_by_membership_id = om.id
FROM organization_members om
WHERE om.user_id = t.changed_by
  AND om.org_id = t.org_id
  AND t.changed_by IS NOT NULL
  AND t.changed_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exceptions t
SET resolved_by_membership_id = om.id
FROM organization_members om
WHERE om.user_id = t.resolved_by
  AND om.org_id = t.org_id
  AND t.resolved_by IS NOT NULL
  AND t.resolved_by_membership_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  unmapped bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM timesheets WHERE locked_by IS NOT NULL AND locked_by_membership_id IS NULL)
  + (SELECT count(*) FROM timesheet_exports WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL)
  + (SELECT count(*) FROM timesheet_exports WHERE ack_by IS NOT NULL AND ack_by_membership_id IS NULL)
  + (SELECT count(*) FROM timesheet_settings_history WHERE changed_by IS NOT NULL AND changed_by_membership_id IS NULL)
  + (SELECT count(*) FROM timesheet_exceptions WHERE resolved_by IS NOT NULL AND resolved_by_membership_id IS NULL)
  INTO unmapped;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'refusing to drop legacy actor columns: % row(s) still carry a legacy actor with no membership counterpart', unmapped;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "timesheets" DROP COLUMN IF EXISTS "locked_by";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" DROP COLUMN IF EXISTS "created_by";
--> statement-breakpoint
ALTER TABLE "timesheet_exports" DROP COLUMN IF EXISTS "ack_by";
--> statement-breakpoint
ALTER TABLE "timesheet_settings_history" DROP COLUMN IF EXISTS "changed_by";
--> statement-breakpoint
ALTER TABLE "timesheet_exceptions" DROP COLUMN IF EXISTS "resolved_by";

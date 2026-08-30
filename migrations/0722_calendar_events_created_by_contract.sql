SET lock_timeout = '5s';
--> statement-breakpoint
UPDATE calendar_events event
SET created_by_membership_id = member.id
FROM organization_members member
WHERE member.org_id = event.org_id
  AND member.user_id = event.created_by
  AND event.created_by_membership_id IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM calendar_events ce
  WHERE NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.id = ce.created_by_membership_id
      AND om.org_id = ce.org_id
  );
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'refusing to drop calendar_events.created_by: % row(s) have a created_by_membership_id with no matching org member', orphaned;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_calendar_events_created_by;
--> statement-breakpoint
ALTER TABLE "calendar_events" DROP COLUMN IF EXISTS "created_by";

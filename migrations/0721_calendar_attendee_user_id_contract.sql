SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
  FROM event_attendees ea
  WHERE NOT EXISTS (
    SELECT 1 FROM organization_members om
    WHERE om.id = ea.membership_id
      AND om.org_id = ea.org_id
  );
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'refusing to drop event_attendees.user_id: % row(s) have an orphaned membership_id with no matching org member', orphaned;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "event_attendees" DROP COLUMN IF EXISTS "user_id";

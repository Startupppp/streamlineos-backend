-- 0847: EXPAND hr_attendance_regularizations with user_membership_id.
--
-- attendance-regularization.service.ts:61 reads eq(hrAttendanceRegularizations.userId, u.userId)
-- as the ownership predicate (own-scope gate). Also used to deduplicate pending requests
-- (line 61-64). A revoked member can still satisfy this unless membership_id is used.
-- approved_by_membership_id already exists; this adds the employee side.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_attendance_regularizations" ar
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = ar.org_id
  AND om.user_id = ar.user_id
  AND ar."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD CONSTRAINT "fk_hr_attendance_regularizations_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_attendance_regularizations_org_user_membership"
  ON "hr_attendance_regularizations" ("org_id", "user_membership_id");

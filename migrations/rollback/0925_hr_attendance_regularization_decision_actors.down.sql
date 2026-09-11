SET lock_timeout = '5s';

ALTER TABLE "hr_attendance_regularizations"
  DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_approved_by_actor";

ALTER TABLE "hr_attendance_regularizations"
  DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_rejected_by_actor";

DROP INDEX IF EXISTS "idx_hr_attendance_regularizations_org_approved_by_membership";
DROP INDEX IF EXISTS "idx_hr_attendance_regularizations_org_rejected_by_membership";

ALTER TABLE "hr_attendance_regularizations"
  DROP COLUMN IF EXISTS "approved_by_membership_id",
  DROP COLUMN IF EXISTS "rejected_by_membership_id";

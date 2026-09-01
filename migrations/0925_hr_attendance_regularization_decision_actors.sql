-- 0925: Preserve HR attendance-regularization decision attribution by membership.
--
-- approved_by and rejected_by remain immutable users.id display projections for
-- historical API responses. The companion membership IDs are the canonical
-- tenant-scoped decision actors.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD COLUMN IF NOT EXISTS "approved_by_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD COLUMN IF NOT EXISTS "rejected_by_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_attendance_regularizations" ar
SET "approved_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = ar.org_id
  AND om.user_id = ar.approved_by
  AND ar.approved_by IS NOT NULL
  AND ar."approved_by_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_attendance_regularizations" ar
SET "rejected_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = ar.org_id
  AND om.user_id = ar.rejected_by
  AND ar.rejected_by IS NOT NULL
  AND ar."rejected_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD CONSTRAINT "fk_hr_attendance_regularizations_approved_by_actor"
  FOREIGN KEY ("org_id", "approved_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("approved_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD CONSTRAINT "fk_hr_attendance_regularizations_rejected_by_actor"
  FOREIGN KEY ("org_id", "rejected_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("rejected_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  VALIDATE CONSTRAINT "fk_hr_attendance_regularizations_approved_by_actor";

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  VALIDATE CONSTRAINT "fk_hr_attendance_regularizations_rejected_by_actor";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_attendance_regularizations_org_approved_by_membership"
  ON "hr_attendance_regularizations" ("org_id", "approved_by_membership_id")
  WHERE "approved_by_membership_id" IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_attendance_regularizations_org_rejected_by_membership"
  ON "hr_attendance_regularizations" ("org_id", "rejected_by_membership_id")
  WHERE "rejected_by_membership_id" IS NOT NULL;

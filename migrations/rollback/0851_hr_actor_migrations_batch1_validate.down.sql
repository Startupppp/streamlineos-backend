-- Rollback 0851: un-validate the FK constraints from migrations 0845-0850.
--
-- VALIDATE CONSTRAINT cannot be undone directly; the only way to return to the
-- NOT VALID state is to drop each constraint and re-add it NOT VALID. No column is
-- dropped and no backfilled data is lost.
--
-- Roll the code back first if services have already switched to using these columns
-- as the authoritative ownership pointer.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "fk_leave_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "fk_leave_requests_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "fk_leave_requests_covering_actor";

--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "fk_leave_requests_covering_actor"
  FOREIGN KEY ("org_id", "covering_employee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("covering_employee_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "wfh_requests" DROP CONSTRAINT IF EXISTS "fk_wfh_requests_user_actor";

--> statement-breakpoint
ALTER TABLE "wfh_requests"
  ADD CONSTRAINT "fk_wfh_requests_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" DROP CONSTRAINT IF EXISTS "fk_hr_attendance_regularizations_user_actor";

--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations"
  ADD CONSTRAINT "fk_hr_attendance_regularizations_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "fk_documents_user_actor";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "fk_documents_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP CONSTRAINT IF EXISTS "fk_hr_cases_assigned_to_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases"
  ADD CONSTRAINT "fk_hr_cases_assigned_to_actor"
  FOREIGN KEY ("org_id", "assigned_to_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assigned_to_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_cases" DROP CONSTRAINT IF EXISTS "fk_hr_cases_reported_by_actor";

--> statement-breakpoint
ALTER TABLE "hr_cases"
  ADD CONSTRAINT "fk_hr_cases_reported_by_actor"
  FOREIGN KEY ("org_id", "reported_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("reported_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "resignations" DROP CONSTRAINT IF EXISTS "fk_resignations_user_actor";

--> statement-breakpoint
ALTER TABLE "resignations"
  ADD CONSTRAINT "fk_resignations_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

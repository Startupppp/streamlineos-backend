-- 0903: EXPAND hr_disciplinary_actions with employee_membership_id.
--
-- hr_disciplinary_actions.employee_id is the employee subject of the disciplinary record.
-- hr-disciplinary.service.ts:38 filters with eq(hrDisciplinaryActions.employeeId, employeeId)
-- and lines 70-71 compose an AND with eq(hrDisciplinaryActions.orgId, orgId). A revoked
-- member can still satisfy this predicate as long as employee_id stores their global users.id.
-- Moving to organization_members.id makes revocation actually revoke.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Validate migration: 0907_hr_actor_batch2_validate.sql.
-- The legacy employee_id column is NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" ADD COLUMN IF NOT EXISTS "employee_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_disciplinary_actions" da
SET "employee_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = da.org_id
  AND om.user_id = da.employee_id
  AND da."employee_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions"
  ADD CONSTRAINT "fk_hr_disciplinary_actions_employee_actor"
  FOREIGN KEY ("org_id", "employee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("employee_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_disciplinary_org_employee_membership"
  ON "hr_disciplinary_actions" ("org_id", "employee_membership_id");

-- 0862: EXPAND payroll_run_employees and payroll_inputs with user_membership_id.
--
-- payroll_run_employees.user_id and payroll_inputs.user_id are the employee subjects in
-- every payroll processing predicate (applyScope ownerColumn and direct eq). These are
-- financial records so user_id is NOT dropped; user_membership_id is the live auth pointer
-- that becomes NULL on membership revocation (SET NULL, PG15+ column-list syntax).

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "payroll_run_employees" pre
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = pre.org_id
  AND om.user_id = pre.user_id
  AND pre."user_membership_id" IS NULL
  AND pre.user_id IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "payroll_run_employees"
  ADD CONSTRAINT "fk_payroll_run_employees_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_run_employees_org_user_actor"
  ON "payroll_run_employees" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "payroll_inputs" pi
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = pi.org_id
  AND om.user_id = pi.user_id
  AND pi."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "payroll_inputs"
  ADD CONSTRAINT "fk_payroll_inputs_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payroll_inputs_org_user_actor"
  ON "payroll_inputs" ("org_id", "user_membership_id");

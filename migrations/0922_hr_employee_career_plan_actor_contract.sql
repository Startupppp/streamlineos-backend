-- @irreversible
-- 0922: Contract employee career-plan subject and mentor actors to memberships.
-- The table is SQL-managed and has no live service readers; user_id remains the
-- historical display projection while membership ids own tenant authority.

SET lock_timeout = '5s';

ALTER TABLE "employee_career_plans"
  ADD COLUMN IF NOT EXISTS "user_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "mentor_membership_id" integer;

UPDATE "employee_career_plans" plan
SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = plan.org_id
  AND member.user_id = plan.user_id
  AND plan.user_membership_id IS NULL;

UPDATE "employee_career_plans" plan
SET "mentor_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = plan.org_id
  AND member.user_id = plan.mentor_id
  AND plan.mentor_id IS NOT NULL
  AND plan.mentor_membership_id IS NULL;

DO $$
DECLARE unmappable_count bigint;
BEGIN
  SELECT count(*)
  INTO unmappable_count
  FROM "employee_career_plans"
  WHERE (user_id IS NOT NULL AND user_membership_id IS NULL)
     OR (mentor_id IS NOT NULL AND mentor_membership_id IS NULL);

  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0922 blocked: % employee career plan actor row(s) cannot map to an organization membership', unmappable_count;
  END IF;
END $$;

ALTER TABLE "employee_career_plans"
  ADD CONSTRAINT "fk_employee_career_plans_user_membership"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

ALTER TABLE "employee_career_plans"
  ADD CONSTRAINT "fk_employee_career_plans_mentor_membership"
  FOREIGN KEY ("org_id", "mentor_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("mentor_membership_id")
  NOT VALID;

ALTER TABLE "employee_career_plans"
  VALIDATE CONSTRAINT "fk_employee_career_plans_user_membership";

ALTER TABLE "employee_career_plans"
  VALIDATE CONSTRAINT "fk_employee_career_plans_mentor_membership";

CREATE INDEX IF NOT EXISTS "idx_employee_career_plans_org_user_membership"
  ON "employee_career_plans" ("org_id", "user_membership_id");

CREATE INDEX IF NOT EXISTS "idx_employee_career_plans_org_mentor_membership"
  ON "employee_career_plans" ("org_id", "mentor_membership_id");

ALTER TABLE "employee_career_plans"
  DROP CONSTRAINT IF EXISTS "employee_career_plans_user_id_users_id_fk",
  DROP CONSTRAINT IF EXISTS "employee_career_plans_mentor_id_users_id_fk";

-- 0863: EXPAND employee_salary_profiles and payslip_publications with user_membership_id.
--
-- employee_salary_profiles.user_id gates ESS access to an employee's own salary profile.
-- payslip_publications.user_id gates access to payslip download (own payslip gate).
-- Both are financial records; user_id stays for the dual-read window. user_membership_id
-- is the live auth pointer — nulled on revocation (PG15+ SET NULL column-list).

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "employee_salary_profiles" esp
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = esp.org_id
  AND om.user_id = esp.user_id
  AND esp."user_membership_id" IS NULL
  AND esp.user_id IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "employee_salary_profiles"
  ADD CONSTRAINT "fk_employee_salary_profiles_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_salary_profiles_org_user_actor"
  ON "employee_salary_profiles" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "payslip_publications" pp
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = pp.org_id
  AND om.user_id = pp.user_id
  AND pp."user_membership_id" IS NULL
  AND pp.user_id IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "payslip_publications"
  ADD CONSTRAINT "fk_payslip_publications_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslip_publications_org_user_actor"
  ON "payslip_publications" ("org_id", "user_membership_id");

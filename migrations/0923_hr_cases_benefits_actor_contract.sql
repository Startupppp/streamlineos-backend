-- @irreversible
-- 0923: Contract remaining cases and benefits self-service authority to memberships.
--
-- Legacy user IDs remain immutable display projections.  Every scoped write and
-- visibility predicate uses the tenant-bound membership key.  An unmappable
-- legacy authority row stops the migration: choosing an arbitrary membership
-- would preserve access after revocation or across organizations.

SET lock_timeout = '5s';

ALTER TABLE "hr_cases"
  ADD COLUMN IF NOT EXISTS "assigned_to_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "reported_by_membership_id" integer;

ALTER TABLE "hr_case_notes"
  ADD COLUMN IF NOT EXISTS "author_membership_id" integer;

ALTER TABLE "hr_benefit_enrollments"
  ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

ALTER TABLE "hr_dependents"
  ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

ALTER TABLE "hr_insurance_claims"
  ADD COLUMN IF NOT EXISTS "user_membership_id" integer,
  ADD COLUMN IF NOT EXISTS "decided_by_membership_id" integer;

ALTER TABLE "hr_travel_visit_logs"
  ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

UPDATE "hr_cases" row SET "assigned_to_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.assigned_to
  AND row.assigned_to IS NOT NULL AND row.assigned_to_membership_id IS NULL;

UPDATE "hr_cases" row SET "reported_by_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.reported_by
  AND row.reported_by IS NOT NULL AND row.reported_by_membership_id IS NULL;

UPDATE "hr_case_notes" row SET "author_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.author_id
  AND row.author_id IS NOT NULL AND row.author_membership_id IS NULL;

UPDATE "hr_benefit_enrollments" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id
  AND row.user_membership_id IS NULL;

UPDATE "hr_dependents" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id
  AND row.user_membership_id IS NULL;

UPDATE "hr_insurance_claims" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id
  AND row.user_membership_id IS NULL;

UPDATE "hr_insurance_claims" row SET "decided_by_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.decided_by
  AND row.decided_by IS NOT NULL AND row.decided_by_membership_id IS NULL;

UPDATE "hr_travel_visit_logs" row SET "user_membership_id" = member.id
FROM "organization_members" member
WHERE member.org_id = row.org_id AND member.user_id = row.user_id
  AND row.user_membership_id IS NULL;

DO $$
DECLARE unmappable_count bigint;
BEGIN
  SELECT count(*) INTO unmappable_count FROM "hr_cases"
    WHERE (assigned_to IS NOT NULL AND assigned_to_membership_id IS NULL)
       OR (reported_by IS NOT NULL AND reported_by_membership_id IS NULL);
  SELECT unmappable_count + count(*) INTO unmappable_count FROM "hr_case_notes"
    WHERE author_id IS NOT NULL AND author_membership_id IS NULL;
  SELECT unmappable_count + count(*) INTO unmappable_count FROM "hr_benefit_enrollments"
    WHERE user_membership_id IS NULL;
  SELECT unmappable_count + count(*) INTO unmappable_count FROM "hr_dependents"
    WHERE user_membership_id IS NULL;
  SELECT unmappable_count + count(*) INTO unmappable_count FROM "hr_insurance_claims"
    WHERE user_membership_id IS NULL
       OR (decided_by IS NOT NULL AND decided_by_membership_id IS NULL);
  SELECT unmappable_count + count(*) INTO unmappable_count FROM "hr_travel_visit_logs"
    WHERE user_membership_id IS NULL;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0923 blocked: % cases/benefits authority actor row(s) are unmappable', unmappable_count;
  END IF;
END $$;

ALTER TABLE "hr_case_notes" ADD CONSTRAINT "fk_hr_case_notes_author_actor"
  FOREIGN KEY ("org_id", "author_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "hr_benefit_enrollments" ADD CONSTRAINT "fk_hr_benefit_enrollments_user_membership"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "hr_dependents" ADD CONSTRAINT "fk_hr_dependents_user_membership"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "fk_hr_insurance_claims_user_membership"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "fk_hr_insurance_claims_decider_membership"
  FOREIGN KEY ("org_id", "decided_by_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;
ALTER TABLE "hr_travel_visit_logs" ADD CONSTRAINT "fk_hr_travel_visit_logs_user_membership"
  FOREIGN KEY ("org_id", "user_membership_id") REFERENCES "organization_members" ("org_id", "id") ON DELETE SET NULL NOT VALID;

ALTER TABLE "hr_case_notes" VALIDATE CONSTRAINT "fk_hr_case_notes_author_actor";
ALTER TABLE "hr_benefit_enrollments" VALIDATE CONSTRAINT "fk_hr_benefit_enrollments_user_membership";
ALTER TABLE "hr_dependents" VALIDATE CONSTRAINT "fk_hr_dependents_user_membership";
ALTER TABLE "hr_insurance_claims" VALIDATE CONSTRAINT "fk_hr_insurance_claims_user_membership";
ALTER TABLE "hr_insurance_claims" VALIDATE CONSTRAINT "fk_hr_insurance_claims_decider_membership";
ALTER TABLE "hr_travel_visit_logs" VALIDATE CONSTRAINT "fk_hr_travel_visit_logs_user_membership";

CREATE INDEX IF NOT EXISTS "idx_hr_case_notes_org_author_membership" ON "hr_case_notes" ("org_id", "author_membership_id");
CREATE INDEX IF NOT EXISTS "idx_hr_benefit_enrollments_org_user_membership" ON "hr_benefit_enrollments" ("org_id", "user_membership_id");
CREATE INDEX IF NOT EXISTS "idx_hr_dependents_org_user_membership" ON "hr_dependents" ("org_id", "user_membership_id");
CREATE INDEX IF NOT EXISTS "idx_hr_insurance_claims_org_user_membership" ON "hr_insurance_claims" ("org_id", "user_membership_id");
CREATE INDEX IF NOT EXISTS "idx_hr_insurance_claims_org_decider_membership" ON "hr_insurance_claims" ("org_id", "decided_by_membership_id");
CREATE INDEX IF NOT EXISTS "idx_hr_travel_visit_logs_org_user_membership" ON "hr_travel_visit_logs" ("org_id", "user_membership_id");

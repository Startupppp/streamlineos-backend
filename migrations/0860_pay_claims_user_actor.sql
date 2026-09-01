-- 0860: EXPAND reimbursements, salary_loans, bonuses, fnf_settlements with user_membership_id.
--
-- Each table's user_id is the employee subject: it appears in applyScope ownerColumn or direct
-- eq predicates that gate what an employee can see about themselves (ESS). Moving ownership
-- to organization_members.id makes membership revocation revoke access: when a membership row
-- is deleted, SET NULL fires on user_membership_id (PG15+ column-list syntax), so the
-- eq(user_membership_id, membershipId) predicate never matches NULL and the former member
-- sees nothing. The legacy user_id is NOT dropped here — it remains a financial record key
-- for the dual-read transition window.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "reimbursements" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "reimbursements" r
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = r.org_id
  AND om.user_id = r.user_id
  AND r."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "reimbursements"
  ADD CONSTRAINT "fk_reimbursements_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reimbursements_org_user_actor"
  ON "reimbursements" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "salary_loans" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "salary_loans" sl
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = sl.org_id
  AND om.user_id = sl.user_id
  AND sl."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "salary_loans"
  ADD CONSTRAINT "fk_salary_loans_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_salary_loans_org_user_actor"
  ON "salary_loans" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "bonuses" b
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = b.org_id
  AND om.user_id = b.user_id
  AND b."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "bonuses"
  ADD CONSTRAINT "fk_bonuses_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bonuses_org_user_actor"
  ON "bonuses" ("org_id", "user_membership_id");

--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "fnf_settlements" f
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = f.org_id
  AND om.user_id = f.user_id
  AND f."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "fnf_settlements"
  ADD CONSTRAINT "fk_fnf_settlements_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fnf_settlements_org_user_actor"
  ON "fnf_settlements" ("org_id", "user_membership_id");

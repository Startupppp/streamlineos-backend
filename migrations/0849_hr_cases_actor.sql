-- 0849: EXPAND hr_cases with assigned_to_membership_id and reported_by_membership_id.
--
-- hr-cases.service.ts:57 reads eq(hrCases.assignedTo, userId) — non-confidential filter.
-- service-delivery-inbox.service.ts:91 reads or(eq(hrCases.confidential, false), eq(hrCases.assignedTo, userId)).
-- service-delivery-inbox.service.ts:291 reads eq(hrCases.reportedBy, userId) — reporter's own inbox.
-- These are active authorization predicates: a revoked HR agent or reporter can still see cases.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_cases" ADD COLUMN IF NOT EXISTS "assigned_to_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_cases" ADD COLUMN IF NOT EXISTS "reported_by_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_cases" c
SET "assigned_to_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = c.org_id
  AND om.user_id = c.assigned_to
  AND om.status = 'ACTIVE'
  AND c.assigned_to IS NOT NULL
  AND c."assigned_to_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_cases" c
SET "reported_by_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = c.org_id
  AND om.user_id = c.reported_by
  AND om.status = 'ACTIVE'
  AND c.reported_by IS NOT NULL
  AND c."reported_by_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_cases"
  ADD CONSTRAINT "fk_hr_cases_assigned_to_actor"
  FOREIGN KEY ("org_id", "assigned_to_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("assigned_to_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_cases"
  ADD CONSTRAINT "fk_hr_cases_reported_by_actor"
  FOREIGN KEY ("org_id", "reported_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("reported_by_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_cases_org_assigned_membership"
  ON "hr_cases" ("org_id", "assigned_to_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_cases_org_reported_membership"
  ON "hr_cases" ("org_id", "reported_by_membership_id");

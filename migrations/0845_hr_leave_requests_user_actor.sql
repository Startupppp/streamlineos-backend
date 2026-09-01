-- 0845: EXPAND leave_requests with user_membership_id and covering_employee_membership_id.
--
-- leave_requests.user_id is the employee who filed the leave. Every DataScope `own`
-- predicate in leaves-scope.ts reads this column — meaning a revoked member can still
-- satisfy the predicate as long as user_id stores their old global users.id.
-- Moving the ownership link to organization_members.id makes revocation actually revoke:
-- when a membership row is deleted, SET NULL fires on user_membership_id (column-list
-- syntax, PG 15+), so the predicate eq(user_membership_id, actorMembershipId) never
-- matches NULL and the former member sees nothing.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Next migration (validate): runs VALIDATE CONSTRAINT after the new FK is live.
-- The legacy user_id column is NOT dropped here — it remains for the dual-read
-- transition window and is dropped once zero callers read it.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "covering_employee_membership_id" integer;

--> statement-breakpoint
UPDATE "leave_requests" lr
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = lr.org_id
  AND om.user_id = lr.user_id
  AND lr."user_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "leave_requests" lr
SET "covering_employee_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = lr.org_id
  AND om.user_id = lr.covering_employee_id
  AND lr.covering_employee_id IS NOT NULL
  AND lr."covering_employee_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "fk_leave_requests_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "leave_requests"
  ADD CONSTRAINT "fk_leave_requests_covering_actor"
  FOREIGN KEY ("org_id", "covering_employee_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("covering_employee_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leave_requests_org_user_membership"
  ON "leave_requests" ("org_id", "user_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_leave_requests_org_covering_membership"
  ON "leave_requests" ("org_id", "covering_employee_membership_id");

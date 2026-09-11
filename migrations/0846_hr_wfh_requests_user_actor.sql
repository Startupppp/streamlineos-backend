-- 0846: EXPAND wfh_requests with user_membership_id.
--
-- wfh_requests.user_id gates self-service WFH reads: hr-calendar-sub-sources.ts:63 and
-- hr-calendar-source.ts:234 both read eq(wfhRequests.userId, ctx.userId) to scope the
-- calendar view. approver_membership_id already exists (migration 0819); this adds the
-- employee side so revocation zeros out both the request and the approval sides.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "wfh_requests" wr
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = wr.org_id
  AND om.user_id = wr.user_id
  AND om.status = 'ACTIVE'
  AND wr."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "wfh_requests"
  ADD CONSTRAINT "fk_wfh_requests_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wfh_requests_org_user_membership"
  ON "wfh_requests" ("org_id", "user_membership_id");

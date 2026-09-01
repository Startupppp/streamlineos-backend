-- 0850: EXPAND resignations with user_membership_id.
--
-- exit.service.ts:70 reads eq(resignations.userId, userId) to scope non-admin list access.
-- exit-write.service.ts:69 reads eq(resignations.userId, actorUserId) to gate writes.
-- These are authority predicates: a revoked member's resignation stays visible to them.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "resignations" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "resignations" r
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = r.org_id
  AND om.user_id = r.user_id
  AND r."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "resignations"
  ADD CONSTRAINT "fk_resignations_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resignations_org_user_membership"
  ON "resignations" ("org_id", "user_membership_id");

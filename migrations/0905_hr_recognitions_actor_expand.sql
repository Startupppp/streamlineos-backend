-- 0905: EXPAND recognitions with from_membership_id and to_membership_id.
--
-- recognitions.from_user_id is the member sending the recognition;
-- to_user_id is the member receiving it. engagement.service.ts:223 filters sender-view
-- with eq(recognitions.fromUserId, userId). A revoked member can still satisfy this
-- predicate as long as from_user_id stores their global users.id. Moving to
-- organization_members.id makes revocation actually revoke both the sender and recipient
-- visibility paths.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Validate migration: 0907_hr_actor_batch2_validate.sql.
-- The legacy from_user_id and to_user_id columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "recognitions" ADD COLUMN IF NOT EXISTS "from_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "recognitions" ADD COLUMN IF NOT EXISTS "to_membership_id" integer;

--> statement-breakpoint
UPDATE "recognitions" r
SET "from_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = r.org_id
  AND om.user_id = r.from_user_id
  AND om.status = 'ACTIVE'
  AND r."from_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "recognitions" r
SET "to_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = r.org_id
  AND om.user_id = r.to_user_id
  AND om.status = 'ACTIVE'
  AND r."to_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "recognitions"
  ADD CONSTRAINT "fk_recognitions_from_actor"
  FOREIGN KEY ("org_id", "from_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("from_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "recognitions"
  ADD CONSTRAINT "fk_recognitions_to_actor"
  FOREIGN KEY ("org_id", "to_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("to_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recognitions_org_from_membership"
  ON "recognitions" ("org_id", "from_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recognitions_org_to_membership"
  ON "recognitions" ("org_id", "to_membership_id");

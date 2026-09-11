-- 0902: EXPAND hr_wellness_checkins and hr_mood_checkins with user_membership_id.
--
-- hr_wellness_checkins.user_id and hr_mood_checkins.user_id are the employees who
-- submitted their own check-in. hr-safety.service.ts:298 filters wellness records with
-- eq(hrWellnessCheckins.userId, userId), and engagement-mood-polls.service.ts:60 filters
-- mood records with eq(hrMoodCheckins.userId, userId). A revoked member can still satisfy
-- these predicates as long as user_id stores their old global users.id.
-- Moving to organization_members.id makes revocation actually revoke.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Validate migration: 0907_hr_actor_batch2_validate.sql.
-- The legacy user_id column is NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" ADD COLUMN IF NOT EXISTS "user_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_wellness_checkins" wc
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = wc.org_id
  AND om.user_id = wc.user_id
  AND om.status = 'ACTIVE'
  AND wc."user_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_mood_checkins" mc
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = mc.org_id
  AND om.user_id = mc.user_id
  AND om.status = 'ACTIVE'
  AND mc."user_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins"
  ADD CONSTRAINT "fk_hr_wellness_checkins_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_mood_checkins"
  ADD CONSTRAINT "fk_hr_mood_checkins_user_actor"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_wellness_org_user_membership"
  ON "hr_wellness_checkins" ("org_id", "user_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mood_checkins_org_user_membership"
  ON "hr_mood_checkins" ("org_id", "user_membership_id");

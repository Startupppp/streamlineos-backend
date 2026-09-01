-- 0904: EXPAND hr_proxy_access with grantor_membership_id and proxy_membership_id.
--
-- hr_proxy_access.grantor_user_id is the member granting delegation authority;
-- proxy_user_id is the member receiving it. delegations.service.ts:30 filters with
-- or(eq(hrProxyAccess.grantorUserId, userId), eq(hrProxyAccess.proxyUserId, userId)).
-- A revoked member can still satisfy either side of this predicate as long as
-- the columns store global users.id. Moving to organization_members.id makes revocation
-- actually revoke both directions.
--
-- Phase: EXPAND + BACKFILL + NOT VALID FK.
-- Validate migration: 0907_hr_actor_batch2_validate.sql.
-- The legacy grantor_user_id and proxy_user_id columns are NOT dropped here.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD COLUMN IF NOT EXISTS "grantor_membership_id" integer;

--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD COLUMN IF NOT EXISTS "proxy_membership_id" integer;

--> statement-breakpoint
UPDATE "hr_proxy_access" pa
SET "grantor_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = pa.org_id
  AND om.user_id = pa.grantor_user_id
  AND om.status = 'ACTIVE'
  AND pa."grantor_membership_id" IS NULL;

--> statement-breakpoint
UPDATE "hr_proxy_access" pa
SET "proxy_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = pa.org_id
  AND om.user_id = pa.proxy_user_id
  AND om.status = 'ACTIVE'
  AND pa."proxy_membership_id" IS NULL;

--> statement-breakpoint
ALTER TABLE "hr_proxy_access"
  ADD CONSTRAINT "fk_hr_proxy_access_grantor_actor"
  FOREIGN KEY ("org_id", "grantor_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("grantor_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "hr_proxy_access"
  ADD CONSTRAINT "fk_hr_proxy_access_proxy_actor"
  FOREIGN KEY ("org_id", "proxy_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("proxy_membership_id")
  NOT VALID;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_proxy_access_org_grantor_membership"
  ON "hr_proxy_access" ("org_id", "grantor_membership_id");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hr_proxy_access_org_proxy_membership"
  ON "hr_proxy_access" ("org_id", "proxy_membership_id");

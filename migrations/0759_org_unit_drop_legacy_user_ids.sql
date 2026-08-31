SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_org_unit_members_unit_user";
--> statement-breakpoint
ALTER TABLE "org_unit_members" DROP COLUMN "user_id";
--> statement-breakpoint
ALTER TABLE "org_units" DROP COLUMN "head_user_id";
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_unit_members_unit_membership" ON "org_unit_members" ("org_unit_id", "membership_id");

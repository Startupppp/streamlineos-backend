SET lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM "org_unit_members" WHERE membership_id IS NULL;
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  ADD CONSTRAINT "chk_oum_membership_id_not_null"
  CHECK (membership_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  VALIDATE CONSTRAINT "chk_oum_membership_id_not_null";
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  ALTER COLUMN "membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_unit_members"
  DROP CONSTRAINT "chk_oum_membership_id_not_null";

-- 1053 DOWN — returns the membership foreign key to ON DELETE SET NULL (user_membership_id).
--
-- @reopens-a-defect: SET NULL is what left a warehouse-access grant behind with no member
-- after a revocation. Running this reinstates the phantom-grant behaviour. Revert the
-- Drizzle declaration in src/db/schema/inventory/warehouses.ts in the same change.
--
-- @data-loss: the orphaned grant rows the forward migration DELETED are not restored.
-- Nothing in the database records which warehouse each belonged to once the row is gone,
-- because the member pointer was already NULL — there is no identity left to reconstruct
-- from. This file reverses the constraint only.
--
-- The column list is mandatory on the way back as well: org_id leads the composite key and
-- is NOT NULL, so a bare ON DELETE SET NULL would raise 23502 on every parent delete.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  DROP CONSTRAINT IF EXISTS "fk_inv_user_wh_user_mbr";
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  ADD CONSTRAINT "fk_inv_user_wh_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;
--> statement-breakpoint

ALTER TABLE "inv_user_warehouses"
  VALIDATE CONSTRAINT "fk_inv_user_wh_user_mbr";

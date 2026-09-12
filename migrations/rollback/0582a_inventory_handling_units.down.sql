-- 0582.down — Remove handling units (LPN/pallet tracking).
--
-- handling_unit_id is part of the stock natural key, so the unique index has to
-- come down before the column and be rebuilt narrower afterwards. The rebuild is
-- to the pre-0582 shape (org, variant, location, lot, serial); if two stock rows
-- differ only by handling unit, that rebuild fails -- correctly, because those
-- rows are legal under the wide key and duplicates under the narrow one, and
-- merging them is a decision this file must not make silently.
--
-- @data-loss: inv_handling_units, inv_stock_levels, inv_stock_transactions, inv_stock_reservations, inv_grn_lines, inv_pick_list_lines
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_levels_org_hu";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_txn_org_hu";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_res_org_hu";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_stock_levels_natural_key";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP CONSTRAINT IF EXISTS "inv_stock_levels_handling_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP COLUMN IF EXISTS "handling_unit_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP COLUMN IF EXISTS "handling_unit_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" DROP COLUMN IF EXISTS "handling_unit_id";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP COLUMN IF EXISTS "handling_unit_id";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" DROP COLUMN IF EXISTS "handling_unit_id";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_stock_levels_natural_key"
  ON "inv_stock_levels" (
    "org_id", "product_variant_id", "location_id",
    COALESCE("lot_id", 0), COALESCE("serial_id", 0)
  );
--> statement-breakpoint
DROP TABLE IF EXISTS "inv_handling_units" CASCADE;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_handling_unit_status";
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE '0582.down: inv_handling_unit_status still has dependants; left in place.';
WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_handling_unit_kind";
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE '0582.down: inv_handling_unit_kind still has dependants; left in place.';
WHEN undefined_object THEN NULL;
END $$;

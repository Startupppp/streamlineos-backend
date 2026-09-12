-- 0587.down — Remove catch-weight and consignment ownership.
--
-- Two things here are not simple drops.
--
-- `inv_stock_levels.ownership` is part of the natural key: 0587 widened
-- uniq_inv_stock_levels_natural_key to include it, so the column cannot go
-- before the index does. The index is recreated WITHOUT ownership afterwards,
-- which is the shape 0582 left it in -- and that recreation can fail if two rows
-- differ only by ownership, because those rows were legal under the wider key
-- and are duplicates under the narrower one. That is a real failure, not a flaw
-- in this file: it means consignment stock exists and reversing 0587 would have
-- to merge it.
--
-- @data-loss: inv_stock_levels, inv_stock_transactions, inv_products, inv_grn_lines, inv_so_lines
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_levels_org_ownership";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_stock_levels_natural_key";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP COLUMN IF EXISTS "ownership";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP COLUMN IF EXISTS "ownership";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_stock_levels_natural_key"
  ON "inv_stock_levels" (
    "org_id", "product_variant_id", "location_id",
    COALESCE("lot_id", 0), COALESCE("serial_id", 0), COALESCE("handling_unit_id", 0)
  );
--> statement-breakpoint
ALTER TABLE "inv_products" DROP COLUMN IF EXISTS "measure_mode";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP COLUMN IF EXISTS "quantity_pieces";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP COLUMN IF EXISTS "quantity_pieces";
--> statement-breakpoint
-- The two enum types are dropped only if nothing else still uses them. At head
-- they DO still have dependants -- later migrations reused inv_ownership -- so a
-- bare DROP TYPE fails with 2BP01 and takes the whole rollback with it. In a
-- contiguous descent those dependants are already gone and the drop succeeds.
-- Declining loudly is the correct behaviour in both cases; silently leaving a
-- type behind with no message is not.
DO $$ BEGIN
  DROP TYPE "inv_measure_mode";
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE '0587.down: inv_measure_mode still has dependants; left in place.';
WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_ownership";
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE '0587.down: inv_ownership still has dependants; left in place.';
WHEN undefined_object THEN NULL;
END $$;

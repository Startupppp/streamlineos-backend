-- 0517.down — Drop the per-line UOM factor snapshot.
--
-- The whole point of 0517 was that a line remembers the conversion factor it was
-- priced at, so a later edit to the conversion table cannot silently restate
-- historical documents. Dropping the column throws those snapshots away and
-- returns the system to deriving factors live -- the exact behaviour 0517 was
-- written to stop.
--
-- @data-loss: inv_po_lines, inv_so_lines, inv_grn_lines, inv_stock_transfer_lines, inv_stock_adjustment_lines
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_product_uom_conversions_org_product_uom";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" DROP COLUMN IF EXISTS "uom_factor";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP COLUMN IF EXISTS "uom_factor";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP COLUMN IF EXISTS "uom_factor";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" DROP COLUMN IF EXISTS "uom_factor";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" DROP COLUMN IF EXISTS "uom_factor";

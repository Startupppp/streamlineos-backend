-- 0515.down — Remove the ledger invariants.
--
-- These CHECK constraints are what stop a stock transaction from being
-- arithmetically impossible, a bucket from going negative and a transfer from
-- pointing at itself. Reversing this does not corrupt anything by itself; it
-- removes the thing that would have caught the corruption. That is worth saying
-- out loud, because a rollback that "only drops constraints" reads as harmless
-- and is not.
--
-- @data-loss: inv_stock_transactions
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP CONSTRAINT IF EXISTS "chk_inv_stock_transactions_arithmetic";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP CONSTRAINT IF EXISTS "chk_inv_stock_transactions_nonzero";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP CONSTRAINT IF EXISTS "chk_inv_stock_levels_buckets_non_negative";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" DROP CONSTRAINT IF EXISTS "chk_inv_po_lines_quantities";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP CONSTRAINT IF EXISTS "chk_inv_so_lines_quantities";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "chk_inv_grn_lines_quantities";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" DROP CONSTRAINT IF EXISTS "chk_inv_stock_transfer_lines_quantities";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" DROP CONSTRAINT IF EXISTS "chk_inv_stock_transfers_distinct_endpoints";
--> statement-breakpoint
ALTER TABLE "inv_lots" DROP CONSTRAINT IF EXISTS "chk_inv_lots_expiry_after_manufacture";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP COLUMN IF EXISTS "quantity_bucket";
--> statement-breakpoint
DO $$ BEGIN
  DROP TYPE "inv_quantity_bucket";
EXCEPTION WHEN dependent_objects_still_exist THEN NULL; WHEN undefined_object THEN NULL; END $$;

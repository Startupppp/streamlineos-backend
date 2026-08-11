-- 0409.down — Revert transfer cost carry.
SET statement_timeout = 0;
SET lock_timeout = '5s';
ALTER TABLE "inv_stock_transfer_lines" DROP COLUMN IF EXISTS "dispatched_unit_cost";

-- 0404.down — Revert posting date.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_txn_org_posting_date";
ALTER TABLE "inv_stock_transactions" DROP COLUMN IF EXISTS "posting_date";

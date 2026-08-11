-- 0401.down — Revert the COGS ledger.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_avg_cost_history_org_variant";
DROP INDEX IF EXISTS "uniq_inv_avg_cost_history_txn";
DROP TABLE IF EXISTS "inv_average_cost_history";
DROP INDEX IF EXISTS "idx_inv_val_consumptions_org_layer";
DROP INDEX IF EXISTS "idx_inv_val_consumptions_org_txn";
DROP INDEX IF EXISTS "uniq_inv_val_consumptions_txn_layer";
DROP TABLE IF EXISTS "inv_valuation_consumptions";

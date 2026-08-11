-- 0402.down — Revert effective-dated standard costs.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_standard_costs_lookup";
DROP INDEX IF EXISTS "uniq_inv_standard_costs_variant_from";
DROP TABLE IF EXISTS "inv_standard_costs";

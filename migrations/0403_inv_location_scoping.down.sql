-- 0403.down — Revert warehouse-level access scoping.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_user_warehouses_org_user";
DROP INDEX IF EXISTS "uniq_inv_user_warehouses_key";
DROP TABLE IF EXISTS "inv_user_warehouses";

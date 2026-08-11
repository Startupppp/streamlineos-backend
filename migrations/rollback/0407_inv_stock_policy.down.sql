-- 0407.down — Revert stock policy grain and reason codes.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_reason_codes_org_category";
DROP INDEX IF EXISTS "uniq_inv_reason_codes_org_code";
DROP TABLE IF EXISTS "inv_reason_codes";
DROP TYPE IF EXISTS "inv_reason_category";
ALTER TABLE "inv_settings" DROP COLUMN IF EXISTS "adjustment_approval_value_threshold";
ALTER TABLE "inv_products" DROP COLUMN IF EXISTS "allow_negative_stock";

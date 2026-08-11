-- 0406.down — Revert the barcode table.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_barcodes_variant";
DROP INDEX IF EXISTS "idx_inv_barcodes_product";
DROP INDEX IF EXISTS "uniq_inv_barcodes_org_code";
DROP TABLE IF EXISTS "inv_barcodes";
DROP TYPE IF EXISTS "inv_barcode_type";

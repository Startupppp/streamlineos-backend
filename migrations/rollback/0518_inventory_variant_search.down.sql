-- 0518.down — Remove the variant search function and its barcode index.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_variants_barcode_trgm";
--> statement-breakpoint
DROP FUNCTION IF EXISTS app.search_inventory_variant_ids(text, integer);

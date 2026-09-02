-- 1009 DOWN -- restores the two single-column constraints and returns their composite
-- twins to the NO ACTION shape they carried before this migration.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE inv_stock_transactions DROP CONSTRAINT IF EXISTS fk_inv_stock_transactions_product_variant_id_org;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT fk_inv_stock_transactions_product_variant_id_org
  FOREIGN KEY (org_id, product_variant_id) REFERENCES inv_product_variants (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT inv_stock_transactions_product_variant_id_inv_product_variants_
  FOREIGN KEY (product_variant_id) REFERENCES inv_product_variants (id) ON DELETE CASCADE NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions DROP CONSTRAINT IF EXISTS fk_inv_stock_transactions_location_id_org;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT fk_inv_stock_transactions_location_id_org
  FOREIGN KEY (org_id, location_id) REFERENCES inv_locations (org_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions
  ADD CONSTRAINT inv_stock_transactions_location_id_inv_locations_id_fk
  FOREIGN KEY (location_id) REFERENCES inv_locations (id) ON DELETE SET NULL NOT VALID;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_inv_stock_levels_org_variant_loc"
  ON "inv_stock_levels" ("org_id", "product_variant_id", "location_id");

CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_created"
  ON "inv_stock_transactions" ("org_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_inv_products_name_trgm"
  ON "inv_products" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_products_sku_trgm"
  ON "inv_products" USING gin ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_variants_sku_trgm"
  ON "inv_product_variants" USING gin ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_lots_lot_number_trgm"
  ON "inv_lots" USING gin ("lot_number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_serials_serial_number_trgm"
  ON "inv_serial_numbers" USING gin ("serial_number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_vendors_name_trgm"
  ON "inv_vendors" USING gin ("name" gin_trgm_ops);

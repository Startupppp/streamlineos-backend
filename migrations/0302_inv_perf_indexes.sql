-- 0302: Inventory performance index bundle (additive & safe — CREATE INDEX IF NOT EXISTS).
-- Sources (docs/inventory audit 2026-07): S-08 (trigram B-tree -> GIN), S-10 (line-table
-- product_variant_id indexes), S-13 (FIFO valuation partial index), S-05 (valuation layer ->
-- stock transaction FK + index), B3-18 (slow-moving / last-movement supporting index).
-- NOTE: for very large tables, prefer CREATE INDEX CONCURRENTLY (run outside a transaction).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- S-08: plain B-tree trigram indexes cannot serve leading-wildcard ILIKE '%term%' search;
-- replace with GIN gin_trgm_ops so free-text search is index-accelerated.
DROP INDEX IF EXISTS idx_inv_products_name_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_products_name_trgm ON inv_products USING gin (name gin_trgm_ops);
DROP INDEX IF EXISTS idx_inv_products_sku_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_products_sku_trgm ON inv_products USING gin (sku gin_trgm_ops);
DROP INDEX IF EXISTS idx_inv_variants_sku_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_variants_sku_trgm ON inv_product_variants USING gin (sku gin_trgm_ops);
DROP INDEX IF EXISTS idx_inv_vendors_name_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_vendors_name_trgm ON inv_vendors USING gin (name gin_trgm_ops);
DROP INDEX IF EXISTS idx_inv_lots_lot_number_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_lots_lot_number_trgm ON inv_lots USING gin (lot_number gin_trgm_ops);
DROP INDEX IF EXISTS idx_inv_serials_serial_number_trgm;
CREATE INDEX IF NOT EXISTS idx_inv_serials_serial_number_trgm ON inv_serial_numbers USING gin (serial_number gin_trgm_ops);

-- S-10: index product_variant_id on every line/child table (hot "find open docs for variant X" path).
CREATE INDEX IF NOT EXISTS idx_inv_po_lines_variant ON inv_po_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_so_lines_variant ON inv_so_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_shipment_lines_variant ON inv_shipment_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_package_lines_variant ON inv_package_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_stock_transfer_lines_variant ON inv_stock_transfer_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_stock_adjustment_lines_variant ON inv_stock_adjustment_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_pick_list_lines_variant ON inv_pick_list_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_cycle_count_lines_variant ON inv_cycle_count_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_physical_audit_lines_variant ON inv_physical_audit_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_vendor_return_lines_variant ON inv_vendor_return_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_customer_return_lines_variant ON inv_customer_return_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_recall_lines_variant ON inv_recall_lines (product_variant_id);
CREATE INDEX IF NOT EXISTS idx_inv_quality_inspection_lines_variant ON inv_quality_inspection_lines (product_variant_id);

-- S-13: FIFO valuation consumption scans unconsumed layers ordered by created_at; a partial
-- index skips fully-consumed layers (often the majority for mature products).
CREATE INDEX IF NOT EXISTS idx_inv_val_layers_fifo
  ON inv_valuation_layers (org_id, product_variant_id, created_at)
  WHERE remaining_quantity::numeric > 0;

-- S-05: valuation layers reference a stock transaction but had no FK/index.
CREATE INDEX IF NOT EXISTS idx_inv_val_layers_txn ON inv_valuation_layers (stock_transaction_id);
-- FK added NOT VALID so it enforces new writes without failing on any legacy orphan rows;
-- run `ALTER TABLE inv_valuation_layers VALIDATE CONSTRAINT fk_inv_val_layers_txn;` after cleanup.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_val_layers_txn') THEN
    ALTER TABLE inv_valuation_layers
      ADD CONSTRAINT fk_inv_val_layers_txn
      FOREIGN KEY (stock_transaction_id) REFERENCES inv_stock_transactions(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- B3-18: slow-moving / last-movement report subqueries scan transactions by variant + type + time.
CREATE INDEX IF NOT EXISTS idx_inv_txn_org_variant_type_created
  ON inv_stock_transactions (org_id, product_variant_id, transaction_type, created_at);

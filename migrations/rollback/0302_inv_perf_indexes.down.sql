-- 0302.down — Drop the trigram and line-level lookup indexes.
--
-- The pg_trgm extension is deliberately NOT dropped: 0302 created it with
-- IF NOT EXISTS and other modules index against it, so removing it here would
-- reverse far more than this migration added.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_name_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_sku_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_variants_sku_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_vendors_name_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_lots_lot_number_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_serials_serial_number_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_po_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_so_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_shipment_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_package_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_transfer_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_adjustment_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_pick_list_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_cycle_count_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_physical_audit_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_vendor_return_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_customer_return_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_recall_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_quality_inspection_lines_variant";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_val_layers_fifo";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_val_layers_txn";

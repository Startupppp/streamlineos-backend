-- 0575.down — Drop the composite tenant foreign keys.
--
-- 0575 installed 79 composite (org_id, id) foreign keys so a child row cannot
-- reference a parent in another tenant. Dropping them does not move any data; it
-- removes the guarantee that the data is consistent, and nothing re-checks it on
-- the way back up -- 0575 re-adds these NOT VALID and validates, so a cross-tenant
-- row written while they were absent fails the VALIDATE rather than being fixed.
--
-- Generated from the forward migration's own ADD CONSTRAINT list, so the two
-- cannot drift.
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "inv_channel_stock_publications" DROP CONSTRAINT IF EXISTS "fk_inv_channel_stock_publications_channel_id_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_stock_publications" DROP CONSTRAINT IF EXISTS "fk_inv_channel_stock_publications_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines" DROP CONSTRAINT IF EXISTS "fk_inv_customer_return_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines" DROP CONSTRAINT IF EXISTS "fk_inv_customer_return_lines_return_id_org";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP CONSTRAINT IF EXISTS "fk_inv_customer_returns_client_party_id";
--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_count_lines_cycle_count_id_org";
--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_count_lines_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_count_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_counts_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_counts_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "fk_inv_grn_lines_grn_id_org";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" DROP CONSTRAINT IF EXISTS "fk_inv_grn_lines_po_line_id_org";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP CONSTRAINT IF EXISTS "fk_inv_grns_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP CONSTRAINT IF EXISTS "fk_inv_grns_po_id_org";
--> statement-breakpoint
ALTER TABLE "inv_load_lines" DROP CONSTRAINT IF EXISTS "fk_inv_load_lines_load_id_org";
--> statement-breakpoint
ALTER TABLE "inv_load_lines" DROP CONSTRAINT IF EXISTS "fk_inv_load_lines_shipment_id_org";
--> statement-breakpoint
ALTER TABLE "inv_loads" DROP CONSTRAINT IF EXISTS "fk_inv_loads_carrier_id_org";
--> statement-breakpoint
ALTER TABLE "inv_loads" DROP CONSTRAINT IF EXISTS "fk_inv_loads_source_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_locations" DROP CONSTRAINT IF EXISTS "fk_inv_locations_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_lots" DROP CONSTRAINT IF EXISTS "fk_inv_lots_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_package_lines" DROP CONSTRAINT IF EXISTS "fk_inv_package_lines_package_id_org";
--> statement-breakpoint
ALTER TABLE "inv_package_lines" DROP CONSTRAINT IF EXISTS "fk_inv_package_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_packages" DROP CONSTRAINT IF EXISTS "fk_inv_packages_shipment_id_org";
--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" DROP CONSTRAINT IF EXISTS "fk_inv_physical_audit_lines_audit_id_org";
--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" DROP CONSTRAINT IF EXISTS "fk_inv_physical_audit_lines_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" DROP CONSTRAINT IF EXISTS "fk_inv_physical_audit_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_physical_audits" DROP CONSTRAINT IF EXISTS "fk_inv_physical_audits_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" DROP CONSTRAINT IF EXISTS "fk_inv_pick_list_lines_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" DROP CONSTRAINT IF EXISTS "fk_inv_pick_list_lines_pick_list_id_org";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" DROP CONSTRAINT IF EXISTS "fk_inv_pick_list_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_pick_lists" DROP CONSTRAINT IF EXISTS "fk_inv_pick_lists_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" DROP CONSTRAINT IF EXISTS "fk_inv_po_lines_po_id_org";
--> statement-breakpoint
ALTER TABLE "inv_po_lines" DROP CONSTRAINT IF EXISTS "fk_inv_po_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_product_variants" DROP CONSTRAINT IF EXISTS "fk_inv_product_variants_product_id_org";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "fk_inv_products_category_id_org";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "fk_inv_products_purchase_uom_id_org";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP CONSTRAINT IF EXISTS "fk_inv_purchase_orders_vendor_id_org";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP CONSTRAINT IF EXISTS "fk_inv_purchase_orders_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP CONSTRAINT IF EXISTS "fk_inv_quality_holds_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP CONSTRAINT IF EXISTS "fk_inv_quality_holds_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspection_lines" DROP CONSTRAINT IF EXISTS "fk_inv_quality_inspection_lines_inspection_id_org";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspection_lines" DROP CONSTRAINT IF EXISTS "fk_inv_quality_inspection_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_recall_lines" DROP CONSTRAINT IF EXISTS "fk_inv_recall_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_recall_lines" DROP CONSTRAINT IF EXISTS "fk_inv_recall_lines_recall_id_org";
--> statement-breakpoint
ALTER TABLE "inv_reorder_rules" DROP CONSTRAINT IF EXISTS "fk_inv_reorder_rules_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_reorder_rules" DROP CONSTRAINT IF EXISTS "fk_inv_reorder_rules_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_client_party_id";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_invoice_id_org";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_serial_numbers" DROP CONSTRAINT IF EXISTS "fk_inv_serial_numbers_current_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_serial_numbers" DROP CONSTRAINT IF EXISTS "fk_inv_serial_numbers_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_shipment_lines" DROP CONSTRAINT IF EXISTS "fk_inv_shipment_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_shipment_lines" DROP CONSTRAINT IF EXISTS "fk_inv_shipment_lines_shipment_id_org";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP CONSTRAINT IF EXISTS "fk_inv_shipments_carrier_id_org";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP CONSTRAINT IF EXISTS "fk_inv_shipments_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP CONSTRAINT IF EXISTS "fk_inv_so_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_so_lines" DROP CONSTRAINT IF EXISTS "fk_inv_so_lines_so_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adjustment_lines_adjustment_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adjustment_lines_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adjustment_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP CONSTRAINT IF EXISTS "fk_inv_stock_levels_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" DROP CONSTRAINT IF EXISTS "fk_inv_stock_levels_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" DROP CONSTRAINT IF EXISTS "fk_inv_stock_reservations_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" DROP CONSTRAINT IF EXISTS "fk_inv_stock_reservations_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" DROP CONSTRAINT IF EXISTS "fk_inv_stock_reservations_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transactions_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transactions_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transfer_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transfer_lines_transfer_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transfers_from_location_id_org";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" DROP CONSTRAINT IF EXISTS "fk_inv_stock_transfers_from_warehouse_id_org";
--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" DROP CONSTRAINT IF EXISTS "fk_inv_valuation_layers_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" DROP CONSTRAINT IF EXISTS "fk_inv_valuation_layers_stock_transaction_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendor_return_lines" DROP CONSTRAINT IF EXISTS "fk_inv_vendor_return_lines_product_variant_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendor_return_lines" DROP CONSTRAINT IF EXISTS "fk_inv_vendor_return_lines_return_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "fk_inv_vendors_client_id_org";
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "fk_inv_vendors_client_party_id";
--> statement-breakpoint
ALTER TABLE "inv_webhook_events" DROP CONSTRAINT IF EXISTS "fk_inv_webhook_events_webhook_id_org";

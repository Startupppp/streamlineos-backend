-- 0818.down — Remove the actor membership companion columns.
--
-- 0818 added a *_membership_id companion beside each actor user id across 25
-- inventory tables, so an actor resolves inside its own tenant. Dropping the
-- companions loses the membership resolution for every historical row; the user
-- id it sits beside survives, so the rows are not orphaned, but which membership
-- acted is gone and reapplying 0818 backfills only what it can recompute today.
--
-- Generated from the forward migration's own object lists, so the two cannot drift.
--
-- @data-loss: inv_audit_events, inv_customer_returns, inv_cycle_counts, inv_export_jobs, inv_grns, inv_import_jobs, inv_loads, inv_packages, inv_physical_audits, inv_pick_lists, inv_products, inv_purchase_orders
SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_import_jobs_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_export_jobs_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_audit_events_actor_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_vend_ret_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_vend_ret_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_cust_ret_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_cust_ret_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_pick_lists_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_cycle_counts_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_cycle_counts_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_phys_audits_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_phys_audits_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_vendors_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_po_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_po_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_grns_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qi_inspector_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qi_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qh_released_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_qh_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_recall_events_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_sales_orders_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_shipments_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_shipments_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_packages_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_loads_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_txn_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_adj_appr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_adj_posted_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_adj_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_stock_xfer_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_std_costs_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_warehouses_mgr_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_warehouses_cre_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_user_wh_user_mbr";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_user_wh_granted_mbr";
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" DROP CONSTRAINT IF EXISTS "fk_inv_import_jobs_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_export_jobs" DROP CONSTRAINT IF EXISTS "fk_inv_export_jobs_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_audit_events" DROP CONSTRAINT IF EXISTS "fk_inv_audit_events_actor_mbr";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP CONSTRAINT IF EXISTS "fk_inv_products_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" DROP CONSTRAINT IF EXISTS "fk_inv_vend_ret_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" DROP CONSTRAINT IF EXISTS "fk_inv_vend_ret_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP CONSTRAINT IF EXISTS "fk_inv_cust_ret_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP CONSTRAINT IF EXISTS "fk_inv_cust_ret_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_pick_lists" DROP CONSTRAINT IF EXISTS "fk_inv_pick_lists_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_counts_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP CONSTRAINT IF EXISTS "fk_inv_cycle_counts_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_physical_audits" DROP CONSTRAINT IF EXISTS "fk_inv_phys_audits_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_physical_audits" DROP CONSTRAINT IF EXISTS "fk_inv_phys_audits_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP CONSTRAINT IF EXISTS "fk_inv_vendors_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP CONSTRAINT IF EXISTS "fk_inv_po_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP CONSTRAINT IF EXISTS "fk_inv_po_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP CONSTRAINT IF EXISTS "fk_inv_grns_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" DROP CONSTRAINT IF EXISTS "fk_inv_qi_inspector_mbr";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" DROP CONSTRAINT IF EXISTS "fk_inv_qi_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP CONSTRAINT IF EXISTS "fk_inv_qh_released_mbr";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP CONSTRAINT IF EXISTS "fk_inv_qh_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_recall_events" DROP CONSTRAINT IF EXISTS "fk_inv_recall_events_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP CONSTRAINT IF EXISTS "fk_inv_sales_orders_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP CONSTRAINT IF EXISTS "fk_inv_shipments_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP CONSTRAINT IF EXISTS "fk_inv_shipments_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_packages" DROP CONSTRAINT IF EXISTS "fk_inv_packages_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_loads" DROP CONSTRAINT IF EXISTS "fk_inv_loads_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP CONSTRAINT IF EXISTS "fk_inv_stock_txn_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adj_appr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adj_posted_mbr";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP CONSTRAINT IF EXISTS "fk_inv_stock_adj_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" DROP CONSTRAINT IF EXISTS "fk_inv_stock_xfer_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_standard_costs" DROP CONSTRAINT IF EXISTS "fk_inv_std_costs_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_warehouses" DROP CONSTRAINT IF EXISTS "fk_inv_warehouses_mgr_mbr";
--> statement-breakpoint
ALTER TABLE "inv_warehouses" DROP CONSTRAINT IF EXISTS "fk_inv_warehouses_cre_mbr";
--> statement-breakpoint
ALTER TABLE "inv_user_warehouses" DROP CONSTRAINT IF EXISTS "fk_inv_user_wh_user_mbr";
--> statement-breakpoint
ALTER TABLE "inv_user_warehouses" DROP CONSTRAINT IF EXISTS "fk_inv_user_wh_granted_mbr";
--> statement-breakpoint
ALTER TABLE "inv_import_jobs" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_export_jobs" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_audit_events" DROP COLUMN IF EXISTS "actor_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_pick_lists" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_physical_audits" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_physical_audits" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_vendors" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_grns" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" DROP COLUMN IF EXISTS "inspector_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP COLUMN IF EXISTS "released_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_quality_holds" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_recall_events" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_shipments" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_packages" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_loads" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP COLUMN IF EXISTS "approved_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP COLUMN IF EXISTS "posted_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_standard_costs" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_warehouses" DROP COLUMN IF EXISTS "manager_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_warehouses" DROP COLUMN IF EXISTS "created_by_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_user_warehouses" DROP COLUMN IF EXISTS "user_membership_id";
--> statement-breakpoint
ALTER TABLE "inv_user_warehouses" DROP COLUMN IF EXISTS "granted_by_membership_id";

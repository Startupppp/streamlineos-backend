SET lock_timeout = '5s';
--> statement-breakpoint

-- ============================================================
-- 0818 — Inventory legacy-actor membership companion columns
-- ============================================================
-- Additive migration: adds INTEGER membership_id companion columns to every
-- Inventory table that currently references users.id in an organisational-actor
-- role (created_by, approved_by, actor_user_id, manager_user_id, etc.).
--
-- Pattern: ADD COLUMN IF NOT EXISTS → composite FK NOT VALID → partial index
-- → backfill (re-runnable, WHERE companion IS NULL) → VALIDATE CONSTRAINT.
-- No legacy user_id columns are dropped here — drops follow once every reader
-- has been migrated to use the companion column.
--
-- All inventory tables carry org_id; no simple-FK special cases needed.
-- CRITICAL SQL RULES applied (same as 0817):
--   • Every ADD CONSTRAINT preceded by DROP CONSTRAINT IF EXISTS (42710)
--   • Composite ON DELETE SET NULL carries explicit column list (23502)
--   • VALIDATE uses ALTER TABLE t VALIDATE CONSTRAINT c; form (42601)
--   • No statement-breakpoints inside DO $$ ... $$ blocks
--   • Backfills guarded on information_schema + WHERE companion IS NULL
-- ============================================================

-- ============================================================
-- SECTION 1 — ADD COMPANION COLUMNS
-- ============================================================

ALTER TABLE inv_import_jobs ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_export_jobs ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_audit_events ADD COLUMN IF NOT EXISTS actor_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_customer_returns ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_customer_returns ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_pick_lists ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_physical_audits ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_physical_audits ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_vendors ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_grns ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections ADD COLUMN IF NOT EXISTS inspector_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_quality_holds ADD COLUMN IF NOT EXISTS released_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_quality_holds ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_recall_events ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_sales_orders ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_shipments ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_shipments ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_packages ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_loads ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_stock_transactions ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD COLUMN IF NOT EXISTS approved_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD COLUMN IF NOT EXISTS posted_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_stock_transfers ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_standard_costs ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_warehouses ADD COLUMN IF NOT EXISTS manager_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_warehouses ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses ADD COLUMN IF NOT EXISTS granted_by_membership_id INTEGER;
--> statement-breakpoint

-- ============================================================
-- SECTION 2 — FOREIGN KEY CONSTRAINTS (NOT VALID, composite)
-- ============================================================

ALTER TABLE inv_import_jobs DROP CONSTRAINT IF EXISTS fk_inv_import_jobs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_import_jobs ADD CONSTRAINT fk_inv_import_jobs_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_export_jobs DROP CONSTRAINT IF EXISTS fk_inv_export_jobs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_export_jobs ADD CONSTRAINT fk_inv_export_jobs_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_audit_events DROP CONSTRAINT IF EXISTS fk_inv_audit_events_actor_mbr;
--> statement-breakpoint
ALTER TABLE inv_audit_events ADD CONSTRAINT fk_inv_audit_events_actor_mbr
  FOREIGN KEY (org_id, actor_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (actor_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_products DROP CONSTRAINT IF EXISTS fk_inv_products_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_products ADD CONSTRAINT fk_inv_products_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_vendor_returns DROP CONSTRAINT IF EXISTS fk_inv_vend_ret_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns ADD CONSTRAINT fk_inv_vend_ret_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_vendor_returns DROP CONSTRAINT IF EXISTS fk_inv_vend_ret_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns ADD CONSTRAINT fk_inv_vend_ret_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_customer_returns DROP CONSTRAINT IF EXISTS fk_inv_cust_ret_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_customer_returns ADD CONSTRAINT fk_inv_cust_ret_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_customer_returns DROP CONSTRAINT IF EXISTS fk_inv_cust_ret_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_customer_returns ADD CONSTRAINT fk_inv_cust_ret_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_pick_lists DROP CONSTRAINT IF EXISTS fk_inv_pick_lists_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_pick_lists ADD CONSTRAINT fk_inv_pick_lists_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_cycle_counts DROP CONSTRAINT IF EXISTS fk_inv_cycle_counts_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts ADD CONSTRAINT fk_inv_cycle_counts_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_cycle_counts DROP CONSTRAINT IF EXISTS fk_inv_cycle_counts_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts ADD CONSTRAINT fk_inv_cycle_counts_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_physical_audits DROP CONSTRAINT IF EXISTS fk_inv_phys_audits_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_physical_audits ADD CONSTRAINT fk_inv_phys_audits_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_physical_audits DROP CONSTRAINT IF EXISTS fk_inv_phys_audits_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_physical_audits ADD CONSTRAINT fk_inv_phys_audits_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_vendors DROP CONSTRAINT IF EXISTS fk_inv_vendors_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendors ADD CONSTRAINT fk_inv_vendors_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_purchase_orders DROP CONSTRAINT IF EXISTS fk_inv_po_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders ADD CONSTRAINT fk_inv_po_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_purchase_orders DROP CONSTRAINT IF EXISTS fk_inv_po_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders ADD CONSTRAINT fk_inv_po_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_grns DROP CONSTRAINT IF EXISTS fk_inv_grns_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_grns ADD CONSTRAINT fk_inv_grns_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_quality_inspections DROP CONSTRAINT IF EXISTS fk_inv_qi_inspector_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections ADD CONSTRAINT fk_inv_qi_inspector_mbr
  FOREIGN KEY (org_id, inspector_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (inspector_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_quality_inspections DROP CONSTRAINT IF EXISTS fk_inv_qi_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections ADD CONSTRAINT fk_inv_qi_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_quality_holds DROP CONSTRAINT IF EXISTS fk_inv_qh_released_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_holds ADD CONSTRAINT fk_inv_qh_released_mbr
  FOREIGN KEY (org_id, released_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (released_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_quality_holds DROP CONSTRAINT IF EXISTS fk_inv_qh_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_holds ADD CONSTRAINT fk_inv_qh_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_recall_events DROP CONSTRAINT IF EXISTS fk_inv_recall_events_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_recall_events ADD CONSTRAINT fk_inv_recall_events_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_sales_orders DROP CONSTRAINT IF EXISTS fk_inv_sales_orders_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_sales_orders ADD CONSTRAINT fk_inv_sales_orders_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_shipments DROP CONSTRAINT IF EXISTS fk_inv_shipments_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_shipments ADD CONSTRAINT fk_inv_shipments_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_shipments DROP CONSTRAINT IF EXISTS fk_inv_shipments_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_shipments ADD CONSTRAINT fk_inv_shipments_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_packages DROP CONSTRAINT IF EXISTS fk_inv_packages_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_packages ADD CONSTRAINT fk_inv_packages_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_loads DROP CONSTRAINT IF EXISTS fk_inv_loads_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_loads ADD CONSTRAINT fk_inv_loads_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transactions DROP CONSTRAINT IF EXISTS fk_inv_stock_txn_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_transactions ADD CONSTRAINT fk_inv_stock_txn_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_adjustments DROP CONSTRAINT IF EXISTS fk_inv_stock_adj_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD CONSTRAINT fk_inv_stock_adj_appr_mbr
  FOREIGN KEY (org_id, approved_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (approved_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_adjustments DROP CONSTRAINT IF EXISTS fk_inv_stock_adj_posted_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD CONSTRAINT fk_inv_stock_adj_posted_mbr
  FOREIGN KEY (org_id, posted_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (posted_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_adjustments DROP CONSTRAINT IF EXISTS fk_inv_stock_adj_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments ADD CONSTRAINT fk_inv_stock_adj_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_stock_transfers DROP CONSTRAINT IF EXISTS fk_inv_stock_xfer_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_transfers ADD CONSTRAINT fk_inv_stock_xfer_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_standard_costs DROP CONSTRAINT IF EXISTS fk_inv_std_costs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_standard_costs ADD CONSTRAINT fk_inv_std_costs_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_warehouses DROP CONSTRAINT IF EXISTS fk_inv_warehouses_mgr_mbr;
--> statement-breakpoint
ALTER TABLE inv_warehouses ADD CONSTRAINT fk_inv_warehouses_mgr_mbr
  FOREIGN KEY (org_id, manager_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (manager_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_warehouses DROP CONSTRAINT IF EXISTS fk_inv_warehouses_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_warehouses ADD CONSTRAINT fk_inv_warehouses_cre_mbr
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (created_by_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_user_warehouses DROP CONSTRAINT IF EXISTS fk_inv_user_wh_user_mbr;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses ADD CONSTRAINT fk_inv_user_wh_user_mbr
  FOREIGN KEY (org_id, user_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE inv_user_warehouses DROP CONSTRAINT IF EXISTS fk_inv_user_wh_granted_mbr;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses ADD CONSTRAINT fk_inv_user_wh_granted_mbr
  FOREIGN KEY (org_id, granted_by_membership_id)
  REFERENCES organization_members(org_id, id)
  ON DELETE SET NULL (granted_by_membership_id)
  NOT VALID;
--> statement-breakpoint

-- ============================================================
-- SECTION 3 — PARTIAL INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_inv_import_jobs_cre_mbr ON inv_import_jobs (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_export_jobs_cre_mbr ON inv_export_jobs (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_audit_events_actor_mbr ON inv_audit_events (org_id, actor_membership_id) WHERE actor_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_products_cre_mbr ON inv_products (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_vend_ret_cre_mbr ON inv_vendor_returns (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_vend_ret_appr_mbr ON inv_vendor_returns (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_cust_ret_cre_mbr ON inv_customer_returns (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_cust_ret_appr_mbr ON inv_customer_returns (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_pick_lists_cre_mbr ON inv_pick_lists (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_cycle_counts_cre_mbr ON inv_cycle_counts (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_cycle_counts_appr_mbr ON inv_cycle_counts (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_phys_audits_cre_mbr ON inv_physical_audits (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_phys_audits_appr_mbr ON inv_physical_audits (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_vendors_cre_mbr ON inv_vendors (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_po_cre_mbr ON inv_purchase_orders (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_po_appr_mbr ON inv_purchase_orders (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_grns_cre_mbr ON inv_grns (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_qi_inspector_mbr ON inv_quality_inspections (org_id, inspector_membership_id) WHERE inspector_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_qi_cre_mbr ON inv_quality_inspections (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_qh_released_mbr ON inv_quality_holds (org_id, released_by_membership_id) WHERE released_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_qh_cre_mbr ON inv_quality_holds (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_recall_events_cre_mbr ON inv_recall_events (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_sales_orders_cre_mbr ON inv_sales_orders (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_shipments_cre_mbr ON inv_shipments (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_shipments_appr_mbr ON inv_shipments (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_packages_cre_mbr ON inv_packages (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_loads_cre_mbr ON inv_loads (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_cre_mbr ON inv_stock_transactions (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_adj_appr_mbr ON inv_stock_adjustments (org_id, approved_by_membership_id) WHERE approved_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_adj_posted_mbr ON inv_stock_adjustments (org_id, posted_by_membership_id) WHERE posted_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_adj_cre_mbr ON inv_stock_adjustments (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_xfer_cre_mbr ON inv_stock_transfers (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_std_costs_cre_mbr ON inv_standard_costs (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_warehouses_mgr_mbr ON inv_warehouses (org_id, manager_membership_id) WHERE manager_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_warehouses_cre_mbr ON inv_warehouses (org_id, created_by_membership_id) WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_user_wh_user_mbr ON inv_user_warehouses (org_id, user_membership_id) WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_user_wh_granted_mbr ON inv_user_warehouses (org_id, granted_by_membership_id) WHERE granted_by_membership_id IS NOT NULL;
--> statement-breakpoint

-- ============================================================
-- SECTION 4 — BACKFILL (re-runnable: WHERE companion IS NULL)
-- All guarded on information_schema so this block is idempotent.
-- No statement-breakpoints inside the DO block.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_import_jobs' AND column_name='created_by_membership_id') THEN
    UPDATE inv_import_jobs SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_import_jobs.org_id AND om.user_id = inv_import_jobs.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_export_jobs' AND column_name='created_by_membership_id') THEN
    UPDATE inv_export_jobs SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_export_jobs.org_id AND om.user_id = inv_export_jobs.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_audit_events' AND column_name='actor_membership_id') THEN
    UPDATE inv_audit_events SET actor_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_audit_events.org_id AND om.user_id = inv_audit_events.actor_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE actor_membership_id IS NULL AND actor_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_products' AND column_name='created_by_membership_id') THEN
    UPDATE inv_products SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_products.org_id AND om.user_id = inv_products.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_vendor_returns' AND column_name='created_by_membership_id') THEN
    UPDATE inv_vendor_returns SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_vendor_returns.org_id AND om.user_id = inv_vendor_returns.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_vendor_returns' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_vendor_returns SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_vendor_returns.org_id AND om.user_id = inv_vendor_returns.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_customer_returns' AND column_name='created_by_membership_id') THEN
    UPDATE inv_customer_returns SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_customer_returns.org_id AND om.user_id = inv_customer_returns.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_customer_returns' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_customer_returns SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_customer_returns.org_id AND om.user_id = inv_customer_returns.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_pick_lists' AND column_name='created_by_membership_id') THEN
    UPDATE inv_pick_lists SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_pick_lists.org_id AND om.user_id = inv_pick_lists.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_cycle_counts' AND column_name='created_by_membership_id') THEN
    UPDATE inv_cycle_counts SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_cycle_counts.org_id AND om.user_id = inv_cycle_counts.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_cycle_counts' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_cycle_counts SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_cycle_counts.org_id AND om.user_id = inv_cycle_counts.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_physical_audits' AND column_name='created_by_membership_id') THEN
    UPDATE inv_physical_audits SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_physical_audits.org_id AND om.user_id = inv_physical_audits.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_physical_audits' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_physical_audits SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_physical_audits.org_id AND om.user_id = inv_physical_audits.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_vendors' AND column_name='created_by_membership_id') THEN
    UPDATE inv_vendors SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_vendors.org_id AND om.user_id = inv_vendors.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_purchase_orders' AND column_name='created_by_membership_id') THEN
    UPDATE inv_purchase_orders SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_purchase_orders.org_id AND om.user_id = inv_purchase_orders.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_purchase_orders' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_purchase_orders SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_purchase_orders.org_id AND om.user_id = inv_purchase_orders.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_grns' AND column_name='created_by_membership_id') THEN
    UPDATE inv_grns SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_grns.org_id AND om.user_id = inv_grns.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_quality_inspections' AND column_name='inspector_membership_id') THEN
    UPDATE inv_quality_inspections SET inspector_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_quality_inspections.org_id AND om.user_id = inv_quality_inspections.inspector_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE inspector_membership_id IS NULL AND inspector_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_quality_inspections' AND column_name='created_by_membership_id') THEN
    UPDATE inv_quality_inspections SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_quality_inspections.org_id AND om.user_id = inv_quality_inspections.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_quality_holds' AND column_name='released_by_membership_id') THEN
    UPDATE inv_quality_holds SET released_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_quality_holds.org_id AND om.user_id = inv_quality_holds.released_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE released_by_membership_id IS NULL AND released_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_quality_holds' AND column_name='created_by_membership_id') THEN
    UPDATE inv_quality_holds SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_quality_holds.org_id AND om.user_id = inv_quality_holds.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_recall_events' AND column_name='created_by_membership_id') THEN
    UPDATE inv_recall_events SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_recall_events.org_id AND om.user_id = inv_recall_events.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_sales_orders' AND column_name='created_by_membership_id') THEN
    UPDATE inv_sales_orders SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_sales_orders.org_id AND om.user_id = inv_sales_orders.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_shipments' AND column_name='created_by_membership_id') THEN
    UPDATE inv_shipments SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_shipments.org_id AND om.user_id = inv_shipments.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_shipments' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_shipments SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_shipments.org_id AND om.user_id = inv_shipments.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_packages' AND column_name='created_by_membership_id') THEN
    UPDATE inv_packages SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_packages.org_id AND om.user_id = inv_packages.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_loads' AND column_name='created_by_membership_id') THEN
    UPDATE inv_loads SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_loads.org_id AND om.user_id = inv_loads.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_stock_transactions' AND column_name='created_by_membership_id') THEN
    UPDATE inv_stock_transactions SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_stock_transactions.org_id AND om.user_id = inv_stock_transactions.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_stock_adjustments' AND column_name='approved_by_membership_id') THEN
    UPDATE inv_stock_adjustments SET approved_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_stock_adjustments.org_id AND om.user_id = inv_stock_adjustments.approved_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE approved_by_membership_id IS NULL AND approved_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_stock_adjustments' AND column_name='posted_by_membership_id') THEN
    UPDATE inv_stock_adjustments SET posted_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_stock_adjustments.org_id AND om.user_id = inv_stock_adjustments.posted_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE posted_by_membership_id IS NULL AND posted_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_stock_adjustments' AND column_name='created_by_membership_id') THEN
    UPDATE inv_stock_adjustments SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_stock_adjustments.org_id AND om.user_id = inv_stock_adjustments.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_stock_transfers' AND column_name='created_by_membership_id') THEN
    UPDATE inv_stock_transfers SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_stock_transfers.org_id AND om.user_id = inv_stock_transfers.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_standard_costs' AND column_name='created_by_membership_id') THEN
    UPDATE inv_standard_costs SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_standard_costs.org_id AND om.user_id = inv_standard_costs.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_warehouses' AND column_name='manager_membership_id') THEN
    UPDATE inv_warehouses SET manager_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_warehouses.org_id AND om.user_id = inv_warehouses.manager_user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE manager_membership_id IS NULL AND manager_user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_warehouses' AND column_name='created_by_membership_id') THEN
    UPDATE inv_warehouses SET created_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_warehouses.org_id AND om.user_id = inv_warehouses.created_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_user_warehouses' AND column_name='user_membership_id') THEN
    UPDATE inv_user_warehouses SET user_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_user_warehouses.org_id AND om.user_id = inv_user_warehouses.user_id AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE user_membership_id IS NULL AND user_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='inv_user_warehouses' AND column_name='granted_by_membership_id') THEN
    UPDATE inv_user_warehouses SET granted_by_membership_id = (
      SELECT om.id FROM organization_members om WHERE om.org_id = inv_user_warehouses.org_id AND om.user_id = inv_user_warehouses.granted_by AND om.status = 'ACTIVE' LIMIT 1
    ) WHERE granted_by_membership_id IS NULL AND granted_by IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint

-- ============================================================
-- SECTION 5 — VALIDATE CONSTRAINTS
-- ============================================================

ALTER TABLE inv_import_jobs VALIDATE CONSTRAINT fk_inv_import_jobs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_export_jobs VALIDATE CONSTRAINT fk_inv_export_jobs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_audit_events VALIDATE CONSTRAINT fk_inv_audit_events_actor_mbr;
--> statement-breakpoint
ALTER TABLE inv_products VALIDATE CONSTRAINT fk_inv_products_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns VALIDATE CONSTRAINT fk_inv_vend_ret_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendor_returns VALIDATE CONSTRAINT fk_inv_vend_ret_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_customer_returns VALIDATE CONSTRAINT fk_inv_cust_ret_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_customer_returns VALIDATE CONSTRAINT fk_inv_cust_ret_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_pick_lists VALIDATE CONSTRAINT fk_inv_pick_lists_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts VALIDATE CONSTRAINT fk_inv_cycle_counts_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_cycle_counts VALIDATE CONSTRAINT fk_inv_cycle_counts_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_physical_audits VALIDATE CONSTRAINT fk_inv_phys_audits_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_physical_audits VALIDATE CONSTRAINT fk_inv_phys_audits_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_vendors VALIDATE CONSTRAINT fk_inv_vendors_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders VALIDATE CONSTRAINT fk_inv_po_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_purchase_orders VALIDATE CONSTRAINT fk_inv_po_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_grns VALIDATE CONSTRAINT fk_inv_grns_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections VALIDATE CONSTRAINT fk_inv_qi_inspector_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_inspections VALIDATE CONSTRAINT fk_inv_qi_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_holds VALIDATE CONSTRAINT fk_inv_qh_released_mbr;
--> statement-breakpoint
ALTER TABLE inv_quality_holds VALIDATE CONSTRAINT fk_inv_qh_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_recall_events VALIDATE CONSTRAINT fk_inv_recall_events_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_sales_orders VALIDATE CONSTRAINT fk_inv_sales_orders_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_shipments VALIDATE CONSTRAINT fk_inv_shipments_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_shipments VALIDATE CONSTRAINT fk_inv_shipments_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_packages VALIDATE CONSTRAINT fk_inv_packages_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_loads VALIDATE CONSTRAINT fk_inv_loads_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_transactions VALIDATE CONSTRAINT fk_inv_stock_txn_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments VALIDATE CONSTRAINT fk_inv_stock_adj_appr_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments VALIDATE CONSTRAINT fk_inv_stock_adj_posted_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_adjustments VALIDATE CONSTRAINT fk_inv_stock_adj_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_stock_transfers VALIDATE CONSTRAINT fk_inv_stock_xfer_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_standard_costs VALIDATE CONSTRAINT fk_inv_std_costs_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_warehouses VALIDATE CONSTRAINT fk_inv_warehouses_mgr_mbr;
--> statement-breakpoint
ALTER TABLE inv_warehouses VALIDATE CONSTRAINT fk_inv_warehouses_cre_mbr;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses VALIDATE CONSTRAINT fk_inv_user_wh_user_mbr;
--> statement-breakpoint
ALTER TABLE inv_user_warehouses VALIDATE CONSTRAINT fk_inv_user_wh_granted_mbr;
--> statement-breakpoint

-- ============================================================
-- SECTION 6 — INTEGRITY CHECK
-- All 37 composite FKs must carry a single-column SET NULL list
-- to prevent nulling org_id on member deletion (23502).
-- ============================================================

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
  FROM pg_constraint c
  WHERE c.conname IN (
    'fk_inv_import_jobs_cre_mbr',
    'fk_inv_export_jobs_cre_mbr',
    'fk_inv_audit_events_actor_mbr',
    'fk_inv_products_cre_mbr',
    'fk_inv_vend_ret_cre_mbr',
    'fk_inv_vend_ret_appr_mbr',
    'fk_inv_cust_ret_cre_mbr',
    'fk_inv_cust_ret_appr_mbr',
    'fk_inv_pick_lists_cre_mbr',
    'fk_inv_cycle_counts_cre_mbr',
    'fk_inv_cycle_counts_appr_mbr',
    'fk_inv_phys_audits_cre_mbr',
    'fk_inv_phys_audits_appr_mbr',
    'fk_inv_vendors_cre_mbr',
    'fk_inv_po_cre_mbr',
    'fk_inv_po_appr_mbr',
    'fk_inv_grns_cre_mbr',
    'fk_inv_qi_inspector_mbr',
    'fk_inv_qi_cre_mbr',
    'fk_inv_qh_released_mbr',
    'fk_inv_qh_cre_mbr',
    'fk_inv_recall_events_cre_mbr',
    'fk_inv_sales_orders_cre_mbr',
    'fk_inv_shipments_cre_mbr',
    'fk_inv_shipments_appr_mbr',
    'fk_inv_packages_cre_mbr',
    'fk_inv_loads_cre_mbr',
    'fk_inv_stock_txn_cre_mbr',
    'fk_inv_stock_adj_appr_mbr',
    'fk_inv_stock_adj_posted_mbr',
    'fk_inv_stock_adj_cre_mbr',
    'fk_inv_stock_xfer_cre_mbr',
    'fk_inv_std_costs_cre_mbr',
    'fk_inv_warehouses_mgr_mbr',
    'fk_inv_warehouses_cre_mbr',
    'fk_inv_user_wh_user_mbr',
    'fk_inv_user_wh_granted_mbr'
  )
  AND c.contype = 'f'
  AND c.confdeltype = 'n'
  AND (c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0818: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;
END $$;

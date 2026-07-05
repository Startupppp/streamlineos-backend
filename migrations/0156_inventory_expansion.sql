-- ============================================================
-- 0156_inventory_expansion.sql
-- Inventory module additive expansion
-- NOTE: ALTER TYPE ADD VALUE statements run OUTSIDE transactions
-- ============================================================

-- Extend inv_location_type enum
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'RECEIVING';
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'SHIPPING';
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'QUARANTINE';
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'SCRAP';
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'TRANSIT';
ALTER TYPE "public"."inv_location_type" ADD VALUE IF NOT EXISTS 'RETURNS';

-- Extend inv_txn_type enum
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'OPENING_BALANCE';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'VENDOR_RETURN';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'CUSTOMER_RETURN';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'CYCLE_COUNT_GAIN';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'CYCLE_COUNT_LOSS';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'SCRAP';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'QUARANTINE_IN';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'QUARANTINE_OUT';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'RESERVATION_CREATE';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'RESERVATION_RELEASE';
ALTER TYPE "public"."inv_txn_type" ADD VALUE IF NOT EXISTS 'RESERVATION_CONSUME';

-- New enum types
DO $$ BEGIN CREATE TYPE "public"."inv_product_type" AS ENUM('STOCKABLE','CONSUMABLE','SERVICE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_tracking_method" AS ENUM('NONE','LOT','SERIAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_costing_method" AS ENUM('STANDARD','WEIGHTED_AVERAGE','FIFO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_reservation_status" AS ENUM('ACTIVE','CONSUMED','RELEASED','EXPIRED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_lot_status" AS ENUM('ACTIVE','EXPIRED','BLOCKED','CONSUMED','RECALLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_serial_status" AS ENUM('IN_STOCK','RESERVED','SHIPPED','RETURNED','SCRAPPED','QUARANTINE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_vendor_return_reason" AS ENUM('DAMAGED','WRONG_ITEM','EXCESS','EXPIRED','QUALITY_REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_customer_return_disposition" AS ENUM('RESTOCK','QUARANTINE','SCRAP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_pick_list_status" AS ENUM('PENDING','IN_PROGRESS','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_cycle_count_status" AS ENUM('PLANNED','COUNTING','REVIEW','POSTED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_quality_inspection_status" AS ENUM('PENDING','IN_PROGRESS','PASSED','FAILED','DISPOSITION_REQUIRED','COMPLETED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_quality_hold_status" AS ENUM('ACTIVE','RELEASED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_quality_disposition" AS ENUM('RELEASE_TO_AVAILABLE','QUARANTINE','RETURN_TO_VENDOR','SCRAP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_recall_status" AS ENUM('OPEN','IN_PROGRESS','CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_shipment_status" AS ENUM('DRAFT','PACKED','LABEL_CREATED','SHIPPED','DELIVERED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_package_status" AS ENUM('OPEN','CLOSED','SHIPPED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_load_status" AS ENUM('DRAFT','DISPATCHED','ARRIVED','CLOSED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_channel_type" AS ENUM('INTERNAL','SHOPIFY','WOOCOMMERCE','MARKETPLACE','B2B','THREE_PL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_channel_status" AS ENUM('ACTIVE','PAUSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_channel_pub_status" AS ENUM('PENDING','PUBLISHED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_3pl_status" AS ENUM('DISCONNECTED','CONNECTED','ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_idempotency_status" AS ENUM('IN_FLIGHT','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_job_status" AS ENUM('PENDING','VALIDATING','RUNNING','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_webhook_event_status" AS ENUM('PENDING','DELIVERED','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_reservation_strategy" AS ENUM('MANUAL','AUTO_ON_CONFIRM','FEFO','FIFO'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_expiry_policy" AS ENUM('BLOCK','WARN','ALLOW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "public"."inv_ai_insight_status" AS ENUM('NEW','ACKNOWLEDGED','DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- ALTER EXISTING TABLES (additive columns)
-- ============================================================

-- inv_uom: new columns
ALTER TABLE "inv_uom" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "inv_uom" ADD COLUMN IF NOT EXISTS "ratio_to_base" numeric(18,8) DEFAULT 1;
ALTER TABLE "inv_uom" ADD COLUMN IF NOT EXISTS "rounding_precision" integer DEFAULT 2;
ALTER TABLE "inv_uom" ADD COLUMN IF NOT EXISTS "is_base" boolean DEFAULT false;

-- inv_products: new columns
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "product_type" "inv_product_type" DEFAULT 'STOCKABLE';
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "tracking_method" "inv_tracking_method" DEFAULT 'NONE';
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "costing_method" "inv_costing_method" DEFAULT 'WEIGHTED_AVERAGE';
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "standard_cost" numeric(18,4);
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "purchase_uom_id" integer REFERENCES inv_uom(id) ON DELETE SET NULL;
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "sales_uom_id" integer REFERENCES inv_uom(id) ON DELETE SET NULL;
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "default_vendor_id" integer;
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "reorder_enabled" boolean DEFAULT false;

-- inv_warehouses: new columns
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "branch_id" text REFERENCES org_branches(id) ON DELETE SET NULL;
ALTER TABLE "inv_warehouses" ADD COLUMN IF NOT EXISTS "manager_user_id" text REFERENCES users(id) ON DELETE SET NULL;

-- inv_locations: new columns
ALTER TABLE "inv_locations" ADD COLUMN IF NOT EXISTS "is_pickable" boolean DEFAULT true;
ALTER TABLE "inv_locations" ADD COLUMN IF NOT EXISTS "is_receivable" boolean DEFAULT true;
ALTER TABLE "inv_locations" ADD COLUMN IF NOT EXISTS "is_sellable" boolean DEFAULT true;
ALTER TABLE "inv_locations" ADD COLUMN IF NOT EXISTS "capacity" numeric(18,4);

-- inv_stock_levels: new columns + replace unique constraint
DROP INDEX IF EXISTS "uniq_inv_stock_variant_location";
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "serial_id" integer;
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "blocked_qty" numeric(18,4) DEFAULT 0;
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "quality_hold_qty" numeric(18,4) DEFAULT 0;
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "outgoing_qty" numeric(18,4) DEFAULT 0;
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "average_cost" numeric(18,4);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_stock_full" ON "inv_stock_levels"("product_variant_id","location_id","lot_id","serial_id") NULLS NOT DISTINCT;

-- inv_stock_transactions: new columns
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "lot_id" integer;
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "serial_id" integer;
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "unit_cost" numeric(18,4);
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "total_cost" numeric(18,4);
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "reason" text;
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "metadata" jsonb;

-- inv_stock_adjustments: new lifecycle columns
ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "approved_by" text REFERENCES users(id);
ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
ALTER TABLE "inv_stock_adjustments" ADD COLUMN IF NOT EXISTS "posted_at" timestamp;

-- inv_stock_transfers: new columns
ALTER TABLE "inv_stock_transfers" ADD COLUMN IF NOT EXISTS "from_warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE RESTRICT;
ALTER TABLE "inv_stock_transfers" ADD COLUMN IF NOT EXISTS "to_warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE RESTRICT;
ALTER TABLE "inv_stock_transfers" ADD COLUMN IF NOT EXISTS "reserved_at" timestamp;
ALTER TABLE "inv_stock_transfers" ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp;

-- ============================================================
-- NEW TABLES
-- ============================================================

-- Reservations
CREATE TABLE IF NOT EXISTS "inv_stock_reservations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_line_id" text,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE SET NULL,
  "location_id" integer REFERENCES inv_locations(id) ON DELETE SET NULL,
  "lot_id" integer,
  "serial_id" integer,
  "reserved_qty" numeric(18,4) NOT NULL,
  "status" "inv_reservation_status" DEFAULT 'ACTIVE' NOT NULL,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Traceability: lots
CREATE TABLE IF NOT EXISTS "inv_lots" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "lot_number" text NOT NULL,
  "manufacture_date" date,
  "expiry_date" date,
  "supplier_lot_number" text,
  "status" "inv_lot_status" DEFAULT 'ACTIVE' NOT NULL,
  "quality_status" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Traceability: serials
CREATE TABLE IF NOT EXISTS "inv_serial_numbers" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "serial_number" text NOT NULL,
  "lot_id" integer,
  "status" "inv_serial_status" DEFAULT 'IN_STOCK' NOT NULL,
  "current_location_id" integer REFERENCES inv_locations(id) ON DELETE SET NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Valuation layers
CREATE TABLE IF NOT EXISTS "inv_valuation_layers" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "stock_transaction_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "unit_cost" numeric(18,4) NOT NULL,
  "total_value" numeric(18,4) NOT NULL,
  "remaining_quantity" numeric(18,4) NOT NULL,
  "remaining_value" numeric(18,4) NOT NULL,
  "costing_method" text NOT NULL,
  "source_type" text,
  "source_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Operations: vendor returns
CREATE TABLE IF NOT EXISTS "inv_vendor_returns" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "return_number" text NOT NULL,
  "vendor_id" integer NOT NULL,
  "po_id" integer,
  "grn_id" integer,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "notes" text,
  "created_by" text NOT NULL REFERENCES users(id),
  "approved_by" text REFERENCES users(id),
  "posted_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_vendor_return_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "return_id" integer NOT NULL REFERENCES inv_vendor_returns(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "reason" "inv_vendor_return_reason" NOT NULL,
  "unit_cost" numeric(18,4)
);

-- Operations: customer returns
CREATE TABLE IF NOT EXISTS "inv_customer_returns" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "return_number" text NOT NULL,
  "so_id" integer,
  "shipment_id" integer,
  "client_id" integer,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "notes" text,
  "created_by" text NOT NULL REFERENCES users(id),
  "approved_by" text REFERENCES users(id),
  "posted_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_customer_return_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "return_id" integer NOT NULL REFERENCES inv_customer_returns(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "disposition" "inv_customer_return_disposition",
  "notes" text
);

-- Operations: pick lists
CREATE TABLE IF NOT EXISTS "inv_pick_lists" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "pick_number" text NOT NULL,
  "so_id" integer,
  "warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  "status" "inv_pick_list_status" DEFAULT 'PENDING' NOT NULL,
  "created_by" text NOT NULL REFERENCES users(id),
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_pick_list_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "pick_list_id" integer NOT NULL REFERENCES inv_pick_lists(id) ON DELETE CASCADE,
  "so_line_id" integer,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "location_id" integer REFERENCES inv_locations(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity_to_pick" numeric(18,4) NOT NULL,
  "quantity_picked" numeric(18,4) DEFAULT 0 NOT NULL
);

-- Operations: cycle counts
CREATE TABLE IF NOT EXISTS "inv_cycle_counts" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "count_number" text NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  "location_id" integer REFERENCES inv_locations(id),
  "category_id" integer,
  "status" "inv_cycle_count_status" DEFAULT 'PLANNED' NOT NULL,
  "created_by" text NOT NULL REFERENCES users(id),
  "approved_by" text REFERENCES users(id),
  "posted_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_cycle_count_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "cycle_count_id" integer NOT NULL REFERENCES inv_cycle_counts(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "location_id" integer NOT NULL REFERENCES inv_locations(id),
  "lot_id" integer,
  "system_qty" numeric(18,4) NOT NULL,
  "counted_qty" numeric(18,4),
  "variance_qty" numeric(18,4)
);

-- Operations: physical audits
CREATE TABLE IF NOT EXISTS "inv_physical_audits" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "audit_number" text NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES inv_warehouses(id) ON DELETE RESTRICT,
  "status" "inv_cycle_count_status" DEFAULT 'PLANNED' NOT NULL,
  "created_by" text NOT NULL REFERENCES users(id),
  "approved_by" text REFERENCES users(id),
  "posted_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_physical_audit_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "audit_id" integer NOT NULL REFERENCES inv_physical_audits(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "location_id" integer NOT NULL REFERENCES inv_locations(id),
  "lot_id" integer,
  "system_qty" numeric(18,4) NOT NULL,
  "counted_qty" numeric(18,4),
  "variance_qty" numeric(18,4)
);

-- Quality
CREATE TABLE IF NOT EXISTS "inv_quality_inspections" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "inspection_number" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "status" "inv_quality_inspection_status" DEFAULT 'PENDING' NOT NULL,
  "inspector_user_id" text REFERENCES users(id),
  "notes" text,
  "completed_at" timestamp,
  "created_by" text NOT NULL REFERENCES users(id),
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_quality_inspection_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "inspection_id" integer NOT NULL REFERENCES inv_quality_inspections(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "result" text,
  "notes" text,
  "disposition" "inv_quality_disposition"
);

CREATE TABLE IF NOT EXISTS "inv_quality_holds" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "location_id" integer REFERENCES inv_locations(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL,
  "reason" text NOT NULL,
  "status" "inv_quality_hold_status" DEFAULT 'ACTIVE' NOT NULL,
  "released_by" text REFERENCES users(id),
  "released_at" timestamp,
  "created_by" text NOT NULL REFERENCES users(id),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_recall_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "recall_number" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "status" "inv_recall_status" DEFAULT 'OPEN' NOT NULL,
  "created_by" text NOT NULL REFERENCES users(id),
  "closed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_recall_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "recall_id" integer NOT NULL REFERENCES inv_recall_events(id) ON DELETE CASCADE,
  "product_variant_id" integer REFERENCES inv_product_variants(id),
  "lot_id" integer,
  "serial_id" integer,
  "status" text DEFAULT 'OPEN' NOT NULL
);

-- Shipping: carriers
CREATE TABLE IF NOT EXISTS "inv_carriers" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name" text NOT NULL,
  "code" text NOT NULL,
  "tracking_url_template" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_shipments" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "shipment_number" text NOT NULL,
  "so_id" integer,
  "warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE SET NULL,
  "carrier_id" integer REFERENCES inv_carriers(id) ON DELETE SET NULL,
  "tracking_number" text,
  "status" "inv_shipment_status" DEFAULT 'DRAFT' NOT NULL,
  "shipped_at" timestamp,
  "created_by" text NOT NULL REFERENCES users(id),
  "approved_by" text REFERENCES users(id),
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_shipment_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "shipment_id" integer NOT NULL REFERENCES inv_shipments(id) ON DELETE CASCADE,
  "so_line_id" integer,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "quantity" numeric(18,4) NOT NULL,
  "lot_id" integer,
  "serial_id" integer
);

CREATE TABLE IF NOT EXISTS "inv_packages" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "package_number" text NOT NULL,
  "shipment_id" integer REFERENCES inv_shipments(id) ON DELETE SET NULL,
  "weight" numeric(18,4),
  "dimensions_l" numeric(10,2),
  "dimensions_w" numeric(10,2),
  "dimensions_h" numeric(10,2),
  "status" "inv_package_status" DEFAULT 'OPEN' NOT NULL,
  "created_by" text NOT NULL REFERENCES users(id),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_package_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "package_id" integer NOT NULL REFERENCES inv_packages(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id),
  "lot_id" integer,
  "serial_id" integer,
  "quantity" numeric(18,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_loads" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "load_number" text NOT NULL,
  "source_warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE SET NULL,
  "destination" text,
  "carrier_id" integer REFERENCES inv_carriers(id) ON DELETE SET NULL,
  "vehicle_ref" text,
  "status" "inv_load_status" DEFAULT 'DRAFT' NOT NULL,
  "dispatch_date" date,
  "arrival_date" date,
  "created_by" text NOT NULL REFERENCES users(id),
  "cancelled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_load_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "load_id" integer NOT NULL REFERENCES inv_loads(id) ON DELETE CASCADE,
  "shipment_id" integer REFERENCES inv_shipments(id) ON DELETE SET NULL,
  "transfer_id" integer
);

-- Channels
CREATE TABLE IF NOT EXISTS "inv_channels" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name" text NOT NULL,
  "channel_type" "inv_channel_type" NOT NULL,
  "status" "inv_channel_status" DEFAULT 'ACTIVE' NOT NULL,
  "safety_buffer" numeric(18,4) DEFAULT 0,
  "publish_threshold" numeric(18,4),
  "warehouse_ids" jsonb DEFAULT '[]'::jsonb,
  "settings" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_channel_stock_publications" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "channel_id" integer NOT NULL REFERENCES inv_channels(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "published_qty" numeric(18,4) DEFAULT 0 NOT NULL,
  "available_qty" numeric(18,4) DEFAULT 0 NOT NULL,
  "status" "inv_channel_pub_status" DEFAULT 'PENDING' NOT NULL,
  "error" text,
  "published_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_3pl_connections" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "status" "inv_3pl_status" DEFAULT 'DISCONNECTED' NOT NULL,
  "external_warehouse_ref" text,
  "sku_mapping" jsonb,
  "last_sync_at" timestamp,
  "last_sync_status" text,
  "settings" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Planning
CREATE TABLE IF NOT EXISTS "inv_reorder_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "product_variant_id" integer NOT NULL REFERENCES inv_product_variants(id) ON DELETE CASCADE,
  "warehouse_id" integer REFERENCES inv_warehouses(id) ON DELETE SET NULL,
  "min_qty" numeric(18,4) NOT NULL,
  "max_qty" numeric(18,4),
  "reorder_qty" numeric(18,4),
  "vendor_id" integer,
  "lead_time_days" integer,
  "safety_stock" numeric(18,4) DEFAULT 0,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_ai_insights" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "insight_type" text NOT NULL,
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "source_refs" jsonb,
  "status" "inv_ai_insight_status" DEFAULT 'NEW' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Admin / settings
CREATE TABLE IF NOT EXISTS "inv_settings" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  "allow_negative_stock" boolean DEFAULT false NOT NULL,
  "allow_backorders" boolean DEFAULT false NOT NULL,
  "reservation_strategy" "inv_reservation_strategy" DEFAULT 'AUTO_ON_CONFIRM' NOT NULL,
  "default_costing_method" "inv_costing_method" DEFAULT 'WEIGHTED_AVERAGE' NOT NULL,
  "expiry_reservation_policy" "inv_expiry_policy" DEFAULT 'BLOCK' NOT NULL,
  "inspection_on_receipt" boolean DEFAULT false NOT NULL,
  "inspection_on_return" boolean DEFAULT false NOT NULL,
  "over_receipt_tolerance_pct" numeric(5,2) DEFAULT 0 NOT NULL,
  "require_po_approval" boolean DEFAULT false NOT NULL,
  "adjustment_approval_threshold" numeric(18,4),
  "auto_reserve_on_confirm" boolean DEFAULT true NOT NULL,
  "allow_partial_shipment" boolean DEFAULT true NOT NULL,
  "package_required_for_shipping" boolean DEFAULT false NOT NULL,
  "channel_publish_policy" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_number_sequences" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "prefix" text NOT NULL,
  "next_number" integer DEFAULT 1 NOT NULL,
  "padding" integer DEFAULT 5 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_idempotency_keys" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_hash" text,
  "status" "inv_idempotency_status" DEFAULT 'IN_FLIGHT' NOT NULL,
  "response" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_import_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "job_type" text NOT NULL,
  "status" "inv_job_status" DEFAULT 'PENDING' NOT NULL,
  "file_name" text,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "processed_rows" integer DEFAULT 0 NOT NULL,
  "error_rows" integer DEFAULT 0 NOT NULL,
  "errors" jsonb,
  "result_url" text,
  "created_by" text NOT NULL REFERENCES users(id),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_export_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "job_type" text NOT NULL,
  "status" "inv_job_status" DEFAULT 'PENDING' NOT NULL,
  "file_name" text,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "processed_rows" integer DEFAULT 0 NOT NULL,
  "error_rows" integer DEFAULT 0 NOT NULL,
  "errors" jsonb,
  "result_url" text,
  "created_by" text NOT NULL REFERENCES users(id),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_webhooks" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "url" text NOT NULL,
  "events" jsonb NOT NULL,
  "secret" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_delivery_at" timestamp,
  "last_delivery_status" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_webhook_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "webhook_id" integer REFERENCES inv_webhooks(id) ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "inv_webhook_event_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "delivered_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "inv_audit_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "actor_user_id" text REFERENCES users(id),
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Stock reservations
CREATE INDEX IF NOT EXISTS "idx_inv_res_org_source" ON "inv_stock_reservations"("org_id","source_type","source_id");
CREATE INDEX IF NOT EXISTS "idx_inv_res_org_variant_status" ON "inv_stock_reservations"("org_id","product_variant_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_res_org_status" ON "inv_stock_reservations"("org_id","status");

-- Lots
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_lots_org_variant_number" ON "inv_lots"("org_id","product_variant_id","lot_number");
CREATE INDEX IF NOT EXISTS "idx_inv_lots_org" ON "inv_lots"("org_id");
CREATE INDEX IF NOT EXISTS "idx_inv_lots_variant" ON "inv_lots"("product_variant_id");
CREATE INDEX IF NOT EXISTS "idx_inv_lots_expiry" ON "inv_lots"("expiry_date");
CREATE INDEX IF NOT EXISTS "idx_inv_lots_status" ON "inv_lots"("org_id","status");

-- Serials
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_serials_org_variant_number" ON "inv_serial_numbers"("org_id","product_variant_id","serial_number");
CREATE INDEX IF NOT EXISTS "idx_inv_serials_org" ON "inv_serial_numbers"("org_id");
CREATE INDEX IF NOT EXISTS "idx_inv_serials_variant" ON "inv_serial_numbers"("product_variant_id");
CREATE INDEX IF NOT EXISTS "idx_inv_serials_status" ON "inv_serial_numbers"("org_id","status");

-- Valuation layers
CREATE INDEX IF NOT EXISTS "idx_inv_val_layers_org_variant" ON "inv_valuation_layers"("org_id","product_variant_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_inv_val_layers_remaining" ON "inv_valuation_layers"("org_id","product_variant_id");

-- Operations
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_vret_org_number" ON "inv_vendor_returns"("org_id","return_number");
CREATE INDEX IF NOT EXISTS "idx_inv_vret_org_status" ON "inv_vendor_returns"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_vret_lines_return" ON "inv_vendor_return_lines"("return_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_cret_org_number" ON "inv_customer_returns"("org_id","return_number");
CREATE INDEX IF NOT EXISTS "idx_inv_cret_org_status" ON "inv_customer_returns"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_cret_lines_return" ON "inv_customer_return_lines"("return_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_pick_org_number" ON "inv_pick_lists"("org_id","pick_number");
CREATE INDEX IF NOT EXISTS "idx_inv_pick_org_status" ON "inv_pick_lists"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_pick_lines_pick" ON "inv_pick_list_lines"("pick_list_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_cc_org_number" ON "inv_cycle_counts"("org_id","count_number");
CREATE INDEX IF NOT EXISTS "idx_inv_cc_org_status" ON "inv_cycle_counts"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_cc_lines_count" ON "inv_cycle_count_lines"("cycle_count_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_pa_org_number" ON "inv_physical_audits"("org_id","audit_number");
CREATE INDEX IF NOT EXISTS "idx_inv_pa_org_status" ON "inv_physical_audits"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_pa_lines_audit" ON "inv_physical_audit_lines"("audit_id");

-- Quality
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_qi_org_number" ON "inv_quality_inspections"("org_id","inspection_number");
CREATE INDEX IF NOT EXISTS "idx_inv_qi_org_status" ON "inv_quality_inspections"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_qi_source" ON "inv_quality_inspections"("org_id","source_type","source_id");
CREATE INDEX IF NOT EXISTS "idx_inv_qi_lines_insp" ON "inv_quality_inspection_lines"("inspection_id");
CREATE INDEX IF NOT EXISTS "idx_inv_qh_org_status" ON "inv_quality_holds"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_qh_variant" ON "inv_quality_holds"("org_id","product_variant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_recall_org_number" ON "inv_recall_events"("org_id","recall_number");
CREATE INDEX IF NOT EXISTS "idx_inv_recall_org_status" ON "inv_recall_events"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_recall_lines_recall" ON "inv_recall_lines"("recall_id");

-- Shipping
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_carriers_org_code" ON "inv_carriers"("org_id","code");
CREATE INDEX IF NOT EXISTS "idx_inv_carriers_org" ON "inv_carriers"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_shipments_org_number" ON "inv_shipments"("org_id","shipment_number");
CREATE INDEX IF NOT EXISTS "idx_inv_shipments_org_status" ON "inv_shipments"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_ship_lines_ship" ON "inv_shipment_lines"("shipment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_packages_org_number" ON "inv_packages"("org_id","package_number");
CREATE INDEX IF NOT EXISTS "idx_inv_packages_org_status" ON "inv_packages"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_pkg_lines_pkg" ON "inv_package_lines"("package_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_loads_org_number" ON "inv_loads"("org_id","load_number");
CREATE INDEX IF NOT EXISTS "idx_inv_loads_org_status" ON "inv_loads"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_load_lines_load" ON "inv_load_lines"("load_id");

-- Channels
CREATE INDEX IF NOT EXISTS "idx_inv_channels_org_status" ON "inv_channels"("org_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_pub_org_channel_variant" ON "inv_channel_stock_publications"("org_id","channel_id","product_variant_id");
CREATE INDEX IF NOT EXISTS "idx_inv_pub_org_channel" ON "inv_channel_stock_publications"("org_id","channel_id");
CREATE INDEX IF NOT EXISTS "idx_inv_pub_status" ON "inv_channel_stock_publications"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_3pl_org_status" ON "inv_3pl_connections"("org_id","status");

-- Planning
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_reorder_org_variant_wh" ON "inv_reorder_rules"("org_id","product_variant_id","warehouse_id") NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS "idx_inv_reorder_org" ON "inv_reorder_rules"("org_id");
CREATE INDEX IF NOT EXISTS "idx_inv_ai_insights_org_status" ON "inv_ai_insights"("org_id","status");

-- Admin
CREATE INDEX IF NOT EXISTS "idx_inv_settings_org" ON "inv_settings"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_numseq_org_doctype" ON "inv_number_sequences"("org_id","doc_type");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_idempotency_org_key" ON "inv_idempotency_keys"("org_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_inv_idempotency_expires" ON "inv_idempotency_keys"("expires_at");
CREATE INDEX IF NOT EXISTS "idx_inv_import_org_status" ON "inv_import_jobs"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_export_org_status" ON "inv_export_jobs"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_webhooks_org" ON "inv_webhooks"("org_id");
CREATE INDEX IF NOT EXISTS "idx_inv_whe_org_status" ON "inv_webhook_events"("org_id","status");
CREATE INDEX IF NOT EXISTS "idx_inv_audit_org_type_created" ON "inv_audit_events"("org_id","resource_type","created_at");
CREATE INDEX IF NOT EXISTS "idx_inv_audit_org_created" ON "inv_audit_events"("org_id","created_at");

-- Additional stock indexes
CREATE INDEX IF NOT EXISTS "idx_inv_stock_lot" ON "inv_stock_levels"("lot_id");
CREATE INDEX IF NOT EXISTS "idx_inv_stock_serial" ON "inv_stock_levels"("serial_id");
CREATE INDEX IF NOT EXISTS "idx_inv_txn_idempotency" ON "inv_stock_transactions"("org_id","idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_inv_warehouses_branch" ON "inv_warehouses"("branch_id");

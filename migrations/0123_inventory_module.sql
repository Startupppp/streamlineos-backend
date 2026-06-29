-- Inventory module tables (incremental migration)

DO $$ BEGIN
  CREATE TYPE "public"."inv_adj_reason" AS ENUM('PURCHASE', 'SALE', 'RETURN', 'DAMAGE', 'EXPIRY', 'THEFT', 'RECOUNT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_grn_quality" AS ENUM('ACCEPTED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_location_type" AS ENUM('ZONE', 'AISLE', 'RACK', 'BIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_po_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_product_status" AS ENUM('ACTIVE', 'INACTIVE', 'DISCONTINUED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_so_status" AS ENUM('DRAFT', 'CONFIRMED', 'SHIPPED', 'INVOICED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_transfer_status" AS ENUM('PENDING', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "public"."inv_txn_type" AS ENUM('PURCHASE', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_IN', 'RETURN_OUT', 'GRN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "inv_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_category_id" integer,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_product_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_id" integer NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"cost_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"selling_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"attribute_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category_id" integer,
	"uom_id" integer,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"description" text,
	"status" "inv_product_status" DEFAULT 'ACTIVE' NOT NULL,
	"cost_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"selling_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(18, 4) DEFAULT '0' NOT NULL,
	"min_stock_level" numeric(18, 4) DEFAULT '0' NOT NULL,
	"max_stock_level" numeric(18, 4) DEFAULT '0' NOT NULL,
	"has_variants" boolean DEFAULT false NOT NULL,
	"image_url" text,
	"custom_fields" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_uom" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"parent_location_id" integer,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"location_type" "inv_location_type" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_stock_adjustment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"adjustment_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"quantity_change" numeric(18, 4) NOT NULL,
	"notes" text
);
CREATE TABLE "inv_stock_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reference_number" text NOT NULL,
	"reason" "inv_adj_reason" NOT NULL,
	"notes" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_stock_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"committed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"on_order" numeric(18, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_stock_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer,
	"transaction_type" "inv_txn_type" NOT NULL,
	"quantity_change" numeric(18, 4) NOT NULL,
	"quantity_before" numeric(18, 4) NOT NULL,
	"quantity_after" numeric(18, 4) NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_stock_transfer_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"transfer_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"notes" text
);
CREATE TABLE "inv_stock_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reference_number" text NOT NULL,
	"from_location_id" integer NOT NULL,
	"to_location_id" integer NOT NULL,
	"status" "inv_transfer_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_grn_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"grn_id" integer NOT NULL,
	"po_line_id" integer NOT NULL,
	"quantity_received" numeric(18, 4) NOT NULL,
	"quality_status" "inv_grn_quality" DEFAULT 'ACCEPTED' NOT NULL,
	"rejection_reason" text
);
CREATE TABLE "inv_grns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"po_id" integer NOT NULL,
	"grn_number" text NOT NULL,
	"received_date" date NOT NULL,
	"location_id" integer,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_po_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL
);
CREATE TABLE "inv_purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"po_number" text NOT NULL,
	"status" "inv_po_status" DEFAULT 'DRAFT' NOT NULL,
	"order_date" date NOT NULL,
	"expected_delivery_date" date,
	"warehouse_id" integer,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"sent_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"gstin" text,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_sales_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"so_number" text NOT NULL,
	"status" "inv_so_status" DEFAULT 'DRAFT' NOT NULL,
	"order_date" date NOT NULL,
	"required_date" date,
	"shipping_address" text,
	"warehouse_id" integer,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"invoice_id" integer,
	"confirmed_at" timestamp,
	"shipped_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "inv_so_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"so_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_shipped" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"cost_at_time" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL
);

ALTER TABLE "inv_categories" ADD CONSTRAINT "inv_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_product_variants" ADD CONSTRAINT "inv_product_variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_product_variants" ADD CONSTRAINT "inv_product_variants_product_id_inv_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."inv_products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_category_id_inv_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."inv_categories"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_uom_id_inv_uom_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."inv_uom"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_uom" ADD CONSTRAINT "inv_uom_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_locations" ADD CONSTRAINT "inv_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_locations" ADD CONSTRAINT "inv_locations_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_adjustment_id_inv_stock_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inv_stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "inv_stock_transfer_lines_transfer_id_inv_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."inv_stock_transfers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "inv_stock_transfer_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_from_location_id_inv_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."inv_locations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_to_location_id_inv_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."inv_locations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_grn_id_inv_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."inv_grns"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_po_line_id_inv_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."inv_po_lines"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_po_id_inv_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."inv_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_po_id_inv_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."inv_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_vendor_id_inv_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."inv_vendors"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inv_so_lines" ADD CONSTRAINT "inv_so_lines_so_id_inv_sales_orders_id_fk" FOREIGN KEY ("so_id") REFERENCES "public"."inv_sales_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inv_so_lines" ADD CONSTRAINT "inv_so_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE restrict ON UPDATE no action;

CREATE INDEX "idx_inv_categories_org" ON "inv_categories" USING btree ("org_id");
CREATE INDEX "idx_inv_categories_parent" ON "inv_categories" USING btree ("parent_category_id");
CREATE UNIQUE INDEX "uniq_inv_variants_org_sku" ON "inv_product_variants" USING btree ("org_id","sku");
CREATE INDEX "idx_inv_variants_product" ON "inv_product_variants" USING btree ("product_id");
CREATE INDEX "idx_inv_variants_barcode" ON "inv_product_variants" USING btree ("barcode");
CREATE UNIQUE INDEX "uniq_inv_products_org_sku" ON "inv_products" USING btree ("org_id","sku");
CREATE INDEX "idx_inv_products_org_status" ON "inv_products" USING btree ("org_id","status");
CREATE INDEX "idx_inv_products_category" ON "inv_products" USING btree ("category_id");
CREATE INDEX "idx_inv_products_barcode" ON "inv_products" USING btree ("barcode");
CREATE UNIQUE INDEX "uniq_inv_uom_org_name" ON "inv_uom" USING btree ("org_id","name");
CREATE INDEX "idx_inv_uom_org" ON "inv_uom" USING btree ("org_id");
CREATE UNIQUE INDEX "uniq_inv_locations_warehouse_code" ON "inv_locations" USING btree ("warehouse_id","code");
CREATE INDEX "idx_inv_locations_org" ON "inv_locations" USING btree ("org_id");
CREATE INDEX "idx_inv_locations_warehouse" ON "inv_locations" USING btree ("warehouse_id");
CREATE INDEX "idx_inv_locations_parent" ON "inv_locations" USING btree ("parent_location_id");
CREATE UNIQUE INDEX "uniq_inv_warehouses_org_code" ON "inv_warehouses" USING btree ("org_id","code");
CREATE INDEX "idx_inv_warehouses_org" ON "inv_warehouses" USING btree ("org_id");
CREATE INDEX "idx_inv_adj_lines_adj" ON "inv_stock_adjustment_lines" USING btree ("adjustment_id");
CREATE UNIQUE INDEX "uniq_inv_adj_org_ref" ON "inv_stock_adjustments" USING btree ("org_id","reference_number");
CREATE INDEX "idx_inv_adj_org" ON "inv_stock_adjustments" USING btree ("org_id");
CREATE UNIQUE INDEX "uniq_inv_stock_variant_location" ON "inv_stock_levels" USING btree ("product_variant_id","location_id");
CREATE INDEX "idx_inv_stock_org" ON "inv_stock_levels" USING btree ("org_id");
CREATE INDEX "idx_inv_stock_variant" ON "inv_stock_levels" USING btree ("product_variant_id");
CREATE INDEX "idx_inv_stock_location" ON "inv_stock_levels" USING btree ("location_id");
CREATE INDEX "idx_inv_txn_org_variant" ON "inv_stock_transactions" USING btree ("org_id","product_variant_id");
CREATE INDEX "idx_inv_txn_org_type" ON "inv_stock_transactions" USING btree ("org_id","transaction_type");
CREATE INDEX "idx_inv_txn_reference" ON "inv_stock_transactions" USING btree ("reference_type","reference_id");
CREATE INDEX "idx_inv_txn_created" ON "inv_stock_transactions" USING btree ("created_at");
CREATE INDEX "idx_inv_transfer_lines_transfer" ON "inv_stock_transfer_lines" USING btree ("transfer_id");
CREATE UNIQUE INDEX "uniq_inv_transfer_org_ref" ON "inv_stock_transfers" USING btree ("org_id","reference_number");
CREATE INDEX "idx_inv_transfers_org_status" ON "inv_stock_transfers" USING btree ("org_id","status");
CREATE INDEX "idx_inv_grn_lines_grn" ON "inv_grn_lines" USING btree ("grn_id");
CREATE UNIQUE INDEX "uniq_inv_grn_org_number" ON "inv_grns" USING btree ("org_id","grn_number");
CREATE INDEX "idx_inv_grn_po" ON "inv_grns" USING btree ("po_id");
CREATE INDEX "idx_inv_po_lines_po" ON "inv_po_lines" USING btree ("po_id");
CREATE UNIQUE INDEX "uniq_inv_po_org_number" ON "inv_purchase_orders" USING btree ("org_id","po_number");
CREATE INDEX "idx_inv_po_org_status" ON "inv_purchase_orders" USING btree ("org_id","status");
CREATE INDEX "idx_inv_po_vendor" ON "inv_purchase_orders" USING btree ("vendor_id");
CREATE INDEX "idx_inv_po_expected_delivery" ON "inv_purchase_orders" USING btree ("expected_delivery_date");
CREATE UNIQUE INDEX "uniq_inv_vendors_org_code" ON "inv_vendors" USING btree ("org_id","code");
CREATE INDEX "idx_inv_vendors_org" ON "inv_vendors" USING btree ("org_id");
CREATE UNIQUE INDEX "uniq_inv_so_org_number" ON "inv_sales_orders" USING btree ("org_id","so_number");
CREATE INDEX "idx_inv_so_org_status" ON "inv_sales_orders" USING btree ("org_id","status");
CREATE INDEX "idx_inv_so_client" ON "inv_sales_orders" USING btree ("client_id");
CREATE INDEX "idx_inv_so_warehouse" ON "inv_sales_orders" USING btree ("warehouse_id");
CREATE INDEX "idx_inv_so_lines_so" ON "inv_so_lines" USING btree ("so_id");

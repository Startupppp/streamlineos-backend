-- NEO-2 -- platform purchase orders and advance shipping notices.
--
-- Blinkit, Instamart and Zepto each run their own dark-store WMS. A brand
-- selling into them is a *supplier*, so the documents that cross the boundary
-- are a purchase order they raise on us and an ASN we answer with. Nothing here
-- moves stock: `inv_grns` is still the only thing a post runs from, and
-- `StockEngineService` is still the only writer of the ledger.
--
-- `inv_platform_purchase_orders` is fenced on `(org, provider,
-- provider_po_number)`. A retried delivery, a re-uploaded file and a re-parsed
-- email land on the same row rather than making three purchase orders -- the
-- failure mode of every file-drop integration that keys on nothing. Rejected
-- documents are KEPT, with the reason on each line: an ops person needs to see
-- that the platform's EAN for a SKU is not one we hold, and a deleted row leaves
-- them an error toast and no evidence.
--
-- Only the digest of the payload is stored, not the payload. A platform PO
-- carries store addresses and contact names, and this table answers "have we
-- already handled PO X" -- it is not a second copy of somebody's order book.
-- Same choice, same reasoning, as `inv_channel_webhook_deliveries` (E6).
--
-- `inv_channels.qc_provider` is what ties an ingested Blinkit PO to a Streamline
-- channel and therefore to that channel's reserved pool (NEO-1): accepting the
-- PO claims the stock, so the same units stop being offered on the storefront.
-- Unique per organisation where set, because two Blinkit channels would make
-- "which pool does this claim into" a question with two answers.
--
-- `inv_grns.asn_id` is nullable and additive. `inv_settings.asn_required_for_grn`
-- defaults false: most warehouses receive against a purchase order and nothing
-- else, and demanding an ASN they do not raise would stop receiving altogether.
-- `pack_quick_commerce` and `qc_zepto_email_po_enabled` default false for the
-- same reason every other pack does.
--
-- Constraints are added NOT VALID and validated separately so no catalogue table
-- is scanned under ACCESS EXCLUSIVE (backend/CLAUDE.md S3).
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_qc_provider" AS ENUM ('BLINKIT', 'INSTAMART', 'ZEPTO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_platform_po_status" AS ENUM ('RECEIVED', 'REJECTED', 'ACCEPTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_asn_status" AS ENUM ('DRAFT', 'CONFIRMED', 'IN_TRANSIT', 'ARRIVED', 'CLOSED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_channels" ADD COLUMN IF NOT EXISTS "qc_provider" "inv_qc_provider";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_channels_org_qc_provider"
  ON "inv_channels" ("org_id", "qc_provider") WHERE "qc_provider" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "pack_quick_commerce" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "qc_zepto_email_po_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_settings" ADD COLUMN IF NOT EXISTS "asn_required_for_grn" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_platform_purchase_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "provider" "inv_qc_provider" NOT NULL,
  "provider_po_number" text NOT NULL,
  "channel_id" integer,
  "warehouse_id" integer,
  "status" "inv_platform_po_status" DEFAULT 'RECEIVED' NOT NULL,
  "destination_ref" text,
  "ordered_at" timestamp,
  "expected_delivery_date" date,
  "currency" text DEFAULT 'INR' NOT NULL,
  "po_id" integer,
  "rejection_reason" text,
  "payload_digest" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_platform_purchase_orders_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_platform_po_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "platform_po_id" integer NOT NULL,
  "line_order" integer DEFAULT 0 NOT NULL,
  "provider_sku" text,
  "ean" text,
  "mrp_paise" bigint,
  "pack_size" integer,
  "quantity_ordered" numeric(18, 4) NOT NULL,
  "unit_cost" numeric(18, 4),
  "product_variant_id" integer,
  "validation_error" text,
  CONSTRAINT "uniq_inv_platform_po_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_platform_po_lines_qty_positive" CHECK ("quantity_ordered" > 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_asns" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "asn_number" text NOT NULL,
  "platform_po_id" integer,
  "po_id" integer NOT NULL,
  "warehouse_id" integer,
  "location_id" integer,
  "status" "inv_asn_status" DEFAULT 'DRAFT' NOT NULL,
  "carrier_name" text,
  "tracking_ref" text,
  "appointment_start" timestamp,
  "appointment_end" timestamp,
  "expected_arrival" date,
  "notes" text,
  "metadata" jsonb,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_asns_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_asns_appointment_window"
    CHECK ("appointment_start" IS NULL OR "appointment_end" IS NULL OR "appointment_end" > "appointment_start")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_asn_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "asn_id" integer NOT NULL,
  "po_line_id" integer,
  "product_variant_id" integer NOT NULL,
  "quantity_expected" numeric(18, 4) NOT NULL,
  "lot_number" text,
  "expiry_date" date,
  "mrp_paise" bigint,
  "line_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "uniq_inv_asn_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_asn_lines_qty_positive" CHECK ("quantity_expected" > 0)
);
--> statement-breakpoint

ALTER TABLE "inv_grns" ADD COLUMN IF NOT EXISTS "asn_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_purchase_orders" ADD CONSTRAINT "inv_platform_purchase_orders_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_channel_org"
    FOREIGN KEY ("org_id", "channel_id") REFERENCES "inv_channels"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_purchase_orders" ADD CONSTRAINT "fk_inv_platform_po_po_org"
    FOREIGN KEY ("org_id", "po_id") REFERENCES "inv_purchase_orders"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_platform_po_lines" ADD CONSTRAINT "inv_platform_po_lines_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_po_lines" ADD CONSTRAINT "fk_inv_platform_po_lines_po_org"
    FOREIGN KEY ("org_id", "platform_po_id") REFERENCES "inv_platform_purchase_orders"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_po_lines" ADD CONSTRAINT "fk_inv_platform_po_lines_variant_org"
    FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "inv_product_variants"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "inv_asns_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "inv_asns_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "inv_asns_platform_po_id_fk"
    FOREIGN KEY ("platform_po_id") REFERENCES "inv_platform_purchase_orders"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "fk_inv_asns_po_org"
    FOREIGN KEY ("org_id", "po_id") REFERENCES "inv_purchase_orders"("org_id", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "fk_inv_asns_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asns" ADD CONSTRAINT "inv_asns_location_id_inv_locations_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "inv_locations"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asn_lines" ADD CONSTRAINT "fk_inv_asn_lines_asn_org"
    FOREIGN KEY ("org_id", "asn_id") REFERENCES "inv_asns"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asn_lines" ADD CONSTRAINT "fk_inv_asn_lines_variant_org"
    FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "inv_product_variants"("org_id", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_asn_lines" ADD CONSTRAINT "inv_asn_lines_po_line_id_inv_po_lines_id_fk"
    FOREIGN KEY ("po_line_id") REFERENCES "inv_po_lines"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_asn_id_inv_asns_id_fk"
    FOREIGN KEY ("asn_id") REFERENCES "inv_asns"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_platform_purchase_orders" VALIDATE CONSTRAINT "inv_platform_purchase_orders_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_platform_purchase_orders" VALIDATE CONSTRAINT "inv_platform_purchase_orders_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_platform_purchase_orders" VALIDATE CONSTRAINT "fk_inv_platform_po_channel_org";
--> statement-breakpoint
ALTER TABLE "inv_platform_purchase_orders" VALIDATE CONSTRAINT "fk_inv_platform_po_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_platform_purchase_orders" VALIDATE CONSTRAINT "fk_inv_platform_po_po_org";
--> statement-breakpoint
ALTER TABLE "inv_platform_po_lines" VALIDATE CONSTRAINT "inv_platform_po_lines_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_platform_po_lines" VALIDATE CONSTRAINT "fk_inv_platform_po_lines_po_org";
--> statement-breakpoint
ALTER TABLE "inv_platform_po_lines" VALIDATE CONSTRAINT "fk_inv_platform_po_lines_variant_org";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "inv_asns_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "inv_asns_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "inv_asns_platform_po_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "fk_inv_asns_po_org";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "fk_inv_asns_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_asns" VALIDATE CONSTRAINT "inv_asns_location_id_inv_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_asn_lines" VALIDATE CONSTRAINT "inv_asn_lines_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_asn_lines" VALIDATE CONSTRAINT "fk_inv_asn_lines_asn_org";
--> statement-breakpoint
ALTER TABLE "inv_asn_lines" VALIDATE CONSTRAINT "fk_inv_asn_lines_variant_org";
--> statement-breakpoint
ALTER TABLE "inv_asn_lines" VALIDATE CONSTRAINT "inv_asn_lines_po_line_id_inv_po_lines_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_grns" VALIDATE CONSTRAINT "inv_grns_asn_id_inv_asns_id_fk";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_platform_po_org_provider_number"
  ON "inv_platform_purchase_orders" ("org_id", "provider", "provider_po_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_po_org_status"
  ON "inv_platform_purchase_orders" ("org_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_po_org_po"
  ON "inv_platform_purchase_orders" ("org_id", "po_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_po_lines_po"
  ON "inv_platform_po_lines" ("org_id", "platform_po_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_po_lines_variant"
  ON "inv_platform_po_lines" ("org_id", "product_variant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_asns_org_number" ON "inv_asns" ("org_id", "asn_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_asns_org_status" ON "inv_asns" ("org_id", "status", "expected_arrival");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_asns_org_po" ON "inv_asns" ("org_id", "po_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_asn_lines_asn" ON "inv_asn_lines" ("org_id", "asn_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_grn_org_asn" ON "inv_grns" ("org_id", "asn_id");
--> statement-breakpoint

-- NEO-3 -- fill rate and payout reconciliation.
--
-- `inv_sales_orders.platform_po_id` is what makes fill rate a join rather than a
-- guess. "Of what they ordered, how much did we ship" needs both halves of the
-- sentence to be facts; matching on dates and channel would produce a number
-- nobody in the room would act on.
--
-- `inv_platform_payout_lines` holds what a platform says it settled. Uploaded,
-- never fetched: there is no connected account. It writes nothing to the general
-- ledger and is not a bank reconciliation -- it compares three documents we
-- already hold and names the lines that disagree. Unmatched rows are KEPT with
-- their reason, because they are the output somebody has to chase.
--
-- The uniqueness fence is `(org, provider, payout_ref, po number, sku-or-ean)`
-- with `coalesce` on the nullable halves, so re-uploading the same file is a
-- no-op. Postgres treats NULLs as distinct, so a plain unique tuple would let
-- one settlement line be counted twice, and a payout counted twice is worse than
-- one counted late.

ALTER TABLE "inv_sales_orders" ADD COLUMN IF NOT EXISTS "platform_po_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_platform_po_id_fk"
    FOREIGN KEY ("platform_po_id") REFERENCES "inv_platform_purchase_orders"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "inv_sales_orders_platform_po_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_so_org_platform_po" ON "inv_sales_orders" ("org_id", "platform_po_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_platform_payout_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "provider" "inv_qc_provider" NOT NULL,
  "payout_ref" text NOT NULL,
  "provider_po_number" text,
  "provider_sku" text,
  "ean" text,
  "quantity" numeric(18, 4) NOT NULL,
  "amount_paise" bigint NOT NULL,
  "settled_on" date,
  "platform_po_line_id" integer,
  "unmatched_reason" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_platform_payout_lines_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_platform_payout_lines_qty_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_payout_lines" ADD CONSTRAINT "inv_platform_payout_lines_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_platform_payout_lines" ADD CONSTRAINT "fk_inv_platform_payout_line_org"
    FOREIGN KEY ("org_id", "platform_po_line_id") REFERENCES "inv_platform_po_lines"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_platform_payout_lines" VALIDATE CONSTRAINT "inv_platform_payout_lines_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_platform_payout_lines" VALIDATE CONSTRAINT "inv_platform_payout_lines_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_platform_payout_lines" VALIDATE CONSTRAINT "fk_inv_platform_payout_line_org";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_platform_payout_line_key"
  ON "inv_platform_payout_lines" (
    "org_id", "provider", "payout_ref",
    coalesce("provider_po_number", ''),
    coalesce("provider_sku", "ean", '')
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_payout_org_provider_po"
  ON "inv_platform_payout_lines" ("org_id", "provider", "provider_po_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_platform_payout_org_unmatched"
  ON "inv_platform_payout_lines" ("org_id", "created_at") WHERE "platform_po_line_id" IS NULL;

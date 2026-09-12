-- NEO-1 -- channel inventory pools.
--
-- A brand selling on Blinkit and on its own storefront holds one pile of stock
-- and makes two promises about it. Before this table both promises were checked
-- against the same availability figure, so the first order on either side could
-- sell units the other had already committed. `inv_channel_pools` records the
-- claim; `ChannelPoolService.availability` is the only place the grain rule is
-- written down; `ReservationService` is the only place it is enforced, because
-- a reservation is the moment stock is actually promised to somebody.
--
-- Nothing here posts stock. A pool is a claim, not a movement: `on_hand` is
-- untouched and `StockEngineService` remains the only writer of the ledger and
-- the projection.
--
-- `warehouse_id` is nullable and the two cases differ. Pinned means the claim is
-- on that warehouse. Unpinned means an organisation-wide claim, and it is
-- subtracted from every warehouse-scoped answer as well as the roll-up -- which
-- over-subtracts across several warehouses, deliberately: refusing an order we
-- could have filled is recoverable, shipping the same unit twice is not.
--
-- Uniqueness is on `coalesce(warehouse_id, 0)` because Postgres treats NULLs as
-- distinct, so a plain unique tuple would let one unpinned pool exist twice for
-- the same channel and variant, each half correct on its own.
--
-- `inv_sales_orders.channel_id` is what lets a Blinkit order draw on the Blinkit
-- pool: availability is computed against every *other* channel's claim, so an
-- order that names its channel sees the units that channel is holding and one
-- that does not, does not. Nullable -- a direct sale names no channel -- and
-- added as a plain nullable column with no backfill, so no table is rewritten.
--
-- The composite tenant FKs are added NOT VALID and validated separately, so the
-- catalogue is never scanned under ACCESS EXCLUSIVE (backend/CLAUDE.md S3).
SET lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_channel_pools" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "channel_id" integer NOT NULL,
  "warehouse_id" integer,
  "product_variant_id" integer NOT NULL,
  "reserved_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
  "published_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_channel_pools_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_channel_pools_reserved_nonneg" CHECK ("reserved_qty" >= 0),
  CONSTRAINT "chk_inv_channel_pools_published_nonneg" CHECK ("published_qty" >= 0)
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_channel_id_inv_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "inv_channels"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_warehouse_id_inv_warehouses_id_fk"
    FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "inv_channel_pools_product_variant_id_inv_product_variants_id_fk"
    FOREIGN KEY ("product_variant_id") REFERENCES "inv_product_variants"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_channel_org"
    FOREIGN KEY ("org_id", "channel_id") REFERENCES "inv_channels"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_channel_pools" ADD CONSTRAINT "fk_inv_channel_pools_variant_org"
    FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "inv_product_variants"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "inv_channel_pools_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "inv_channel_pools_channel_id_inv_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "inv_channel_pools_warehouse_id_inv_warehouses_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "inv_channel_pools_product_variant_id_inv_product_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "fk_inv_channel_pools_channel_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "fk_inv_channel_pools_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_channel_pools" VALIDATE CONSTRAINT "fk_inv_channel_pools_variant_org";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_channel_pools_grain"
  ON "inv_channel_pools" ("org_id", "channel_id", "product_variant_id", coalesce("warehouse_id", 0));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_channel_pools_org_variant_warehouse"
  ON "inv_channel_pools" ("org_id", "product_variant_id", "warehouse_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_channel_pools_org_channel"
  ON "inv_channel_pools" ("org_id", "channel_id");
--> statement-breakpoint

ALTER TABLE "inv_sales_orders" ADD COLUMN IF NOT EXISTS "channel_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_channel_id_inv_channels_id_fk"
    FOREIGN KEY ("channel_id") REFERENCES "inv_channels"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "fk_inv_sales_orders_channel_id_org"
    FOREIGN KEY ("org_id", "channel_id") REFERENCES "inv_channels"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "inv_sales_orders_channel_id_inv_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_sales_orders" VALIDATE CONSTRAINT "fk_inv_sales_orders_channel_id_org";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_so_org_channel" ON "inv_sales_orders" ("org_id", "channel_id");

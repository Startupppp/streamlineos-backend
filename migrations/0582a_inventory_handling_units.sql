-- NEO-4 -- handling units as a stock grain.
--
-- Before this, the finest thing Streamline could name was a bin. A warehouse
-- moves pallets: a putaway is "take LPN 000123 to A-04-2", a pick is "two off
-- LPN 000123", and a truck is loaded with LPNs. Every one of those had to be
-- re-expressed as a quantity of a SKU at a location, which is a translation the
-- floor does in its head and a loss of the identifier the label actually
-- carries. SAP EWM and Manhattan both refuse a warehouse without it.
--
-- ## Stock lives on leaves
--
-- `parent_hu_id` nests. Stock is held against a **leaf** handling unit and never
-- against a parent; a parent's contents are the union of its children's,
-- computed, never stored. That is what makes "a nested carton does not
-- double-count" true by construction: there is no second place the same twelve
-- units could be written down. Two CHECKs and two service refusals keep it so --
-- a unit that holds stock may not be given children, and one that has children
-- may not be given stock.
--
-- ## The natural key changes
--
-- `inv_stock_levels` is keyed on `(org, variant, location, lot, serial)` and
-- gains the handling unit. `coalesce(...,0)` on the nullable halves, because
-- Postgres treats NULLs as distinct and loose stock would otherwise be able to
-- exist twice at one bin -- the same reason lot and serial are already
-- coalesced there.
--
-- Everything that keys against a stock-level row has to follow, or it silently
-- addresses the wrong one. `inv_stock_reservations` and `inv_pick_list_lines`
-- both gain the column, and `EXPECTED_COMMITTED` / `EXPECTED_OUTGOING` both gain
-- the predicate. Leaving those out would repeat, one grain deeper, the exact
-- defect `projection-definitions.ts` documents: two units picked off a pallet
-- would zero the `outgoing_qty` of the loose stock on the same shelf and
-- re-offer units standing in a tote.
--
-- The unique index is dropped and recreated rather than altered, because a
-- unique index on an expression cannot be extended in place. It is small
-- relative to the table's heap and the whole file runs under `lock_timeout`, so
-- a contended run fails fast rather than queueing behind a long read.
--
-- Backfill: none needed. Every existing row has `handling_unit_id` NULL, which
-- is exactly "loose stock in the bin" -- what all of it was.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_handling_unit_kind" AS ENUM ('PALLET', 'CARTON', 'CAGE', 'TOTE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_handling_unit_status" AS ENUM ('OPEN', 'CLOSED', 'SHIPPED', 'EMPTY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_handling_units" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "hu_code" text NOT NULL,
  "kind" "inv_handling_unit_kind" DEFAULT 'PALLET' NOT NULL,
  "status" "inv_handling_unit_status" DEFAULT 'OPEN' NOT NULL,
  "location_id" integer,
  "parent_hu_id" integer,
  "metadata" jsonb,
  "closed_at" timestamp,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_handling_units_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_handling_units_not_self_parent" CHECK ("parent_hu_id" IS DISTINCT FROM "id"),
  CONSTRAINT "chk_inv_handling_units_placed_xor_nested"
    CHECK (("parent_hu_id" IS NULL) OR ("location_id" IS NULL))
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_handling_units" ADD CONSTRAINT "inv_handling_units_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_handling_units" ADD CONSTRAINT "inv_handling_units_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_handling_units" ADD CONSTRAINT "fk_inv_handling_units_location_org"
    FOREIGN KEY ("org_id", "location_id") REFERENCES "inv_locations"("org_id", "id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_handling_units" ADD CONSTRAINT "fk_inv_handling_units_parent_org"
    FOREIGN KEY ("org_id", "parent_hu_id") REFERENCES "inv_handling_units"("org_id", "id") ON DELETE restrict NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_handling_units" VALIDATE CONSTRAINT "inv_handling_units_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_handling_units" VALIDATE CONSTRAINT "inv_handling_units_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_handling_units" VALIDATE CONSTRAINT "fk_inv_handling_units_location_org";
--> statement-breakpoint
ALTER TABLE "inv_handling_units" VALIDATE CONSTRAINT "fk_inv_handling_units_parent_org";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_handling_units_org_code" ON "inv_handling_units" ("org_id", "hu_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_handling_units_org_location" ON "inv_handling_units" ("org_id", "location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_handling_units_org_parent" ON "inv_handling_units" ("org_id", "parent_hu_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_handling_units_org_status" ON "inv_handling_units" ("org_id", "status");
--> statement-breakpoint

ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "handling_unit_id" integer;
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "handling_unit_id" integer;
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" ADD COLUMN IF NOT EXISTS "handling_unit_id" integer;
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" ADD COLUMN IF NOT EXISTS "handling_unit_id" integer;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "handling_unit_id" integer;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_handling_unit_id_fk"
    FOREIGN KEY ("handling_unit_id") REFERENCES "inv_handling_units"("id") ON DELETE restrict NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_handling_unit_id_fk"
    FOREIGN KEY ("handling_unit_id") REFERENCES "inv_handling_units"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "inv_stock_reservations_handling_unit_id_fk"
    FOREIGN KEY ("handling_unit_id") REFERENCES "inv_handling_units"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "inv_pick_list_lines_handling_unit_id_fk"
    FOREIGN KEY ("handling_unit_id") REFERENCES "inv_handling_units"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_handling_unit_id_fk"
    FOREIGN KEY ("handling_unit_id") REFERENCES "inv_handling_units"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_stock_levels" VALIDATE CONSTRAINT "inv_stock_levels_handling_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" VALIDATE CONSTRAINT "inv_stock_transactions_handling_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" VALIDATE CONSTRAINT "inv_stock_reservations_handling_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" VALIDATE CONSTRAINT "inv_pick_list_lines_handling_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "inv_grn_lines_handling_unit_id_fk";
--> statement-breakpoint

-- The natural key. Dropped and recreated because a unique index on an expression
-- cannot be extended in place; every existing row carries NULL, which coalesces
-- to 0 and therefore keeps exactly the uniqueness the old index enforced.
DROP INDEX IF EXISTS "uniq_inv_stock_levels_natural_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_stock_levels_natural_key"
  ON "inv_stock_levels" (
    "org_id", "product_variant_id", "location_id",
    coalesce("lot_id", 0), coalesce("serial_id", 0), coalesce("handling_unit_id", 0)
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_stock_levels_org_hu"
  ON "inv_stock_levels" ("org_id", "handling_unit_id") WHERE "handling_unit_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_txn_org_hu"
  ON "inv_stock_transactions" ("org_id", "handling_unit_id", "created_at" DESC) WHERE "handling_unit_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_res_org_hu"
  ON "inv_stock_reservations" ("org_id", "handling_unit_id") WHERE "handling_unit_id" IS NOT NULL;

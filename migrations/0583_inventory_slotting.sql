-- NEO-6 -- slotting rules, velocity classes and re-slot recommendations.
--
-- Putaway ranked bins by remaining capacity alone, which fills a building evenly
-- and slots it badly: the fastest-moving SKU ends up wherever there happened to
-- be room on the day it arrived, and every pick after that walks to it.
--
-- A rule targets a **zone**, never a bin. Naming a bin makes the rule wrong the
-- moment that bin is full, and the point of a rule is to survive the day to day.
-- The zone is expanded to its descendant bins with a recursive walk at read time.
--
-- Velocity is derived from the ledger on a window and never entered by hand: a
-- class somebody typed in last March is a class that is now wrong. It counts
-- movement *lines*, not units, because slotting is about walks -- a SKU picked a
-- hundred times in ones costs a hundred journeys where one picked once in
-- hundreds costs one.
--
-- Recommendations are read-only output. The nightly sweep records where stock is
-- against where the rules put it and moves nothing; approving one raises an
-- ordinary transfer, so a re-slot is a ledger fact like any other rather than a
-- second posting path. A warehouse that rearranges itself overnight is one where
-- a picker's memory of yesterday is a liability.
--
-- `uniq_inv_slotting_recommendation_open` keeps one live recommendation per
-- grain, so a nightly job cannot bury the ones nobody has looked at yet under
-- identical copies of themselves.
--
-- The CHECK on `inv_slotting_rules` keeps the discriminator and its payload
-- together: a rule that reads as configured and matches nothing is worse than
-- one that was refused, because the planner believes the gold zone is in use.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_velocity_class" AS ENUM ('A', 'B', 'C');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_slotting_match" AS ENUM ('VELOCITY_CLASS', 'CATEGORY', 'PRODUCT_VARIANT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_slotting_recommendation_status" AS ENUM ('PENDING', 'APPROVED', 'DISMISSED', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_slotting_rules" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "name" text NOT NULL,
  "match_type" "inv_slotting_match" NOT NULL,
  "velocity_class" "inv_velocity_class",
  "category_id" integer,
  "product_variant_id" integer,
  "target_zone_location_id" integer NOT NULL,
  "target_location_type" "inv_location_type",
  "priority" integer DEFAULT 100 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_slotting_rules_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_slotting_rules_match_payload" CHECK (
    ("match_type" = 'VELOCITY_CLASS' AND "velocity_class" IS NOT NULL AND "category_id" IS NULL AND "product_variant_id" IS NULL)
    OR ("match_type" = 'CATEGORY' AND "category_id" IS NOT NULL AND "velocity_class" IS NULL AND "product_variant_id" IS NULL)
    OR ("match_type" = 'PRODUCT_VARIANT' AND "product_variant_id" IS NOT NULL AND "velocity_class" IS NULL AND "category_id" IS NULL)
  )
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_velocity_classes" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "velocity_class" "inv_velocity_class" NOT NULL,
  "pick_count" integer DEFAULT 0 NOT NULL,
  "issued_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
  "window_days" integer NOT NULL,
  "computed_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_velocity_classes_org_id" UNIQUE ("org_id", "id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inv_slotting_recommendations" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "warehouse_id" integer NOT NULL,
  "product_variant_id" integer NOT NULL,
  "from_location_id" integer NOT NULL,
  "to_zone_location_id" integer NOT NULL,
  "quantity" numeric(18, 4) NOT NULL,
  "rule_id" integer,
  "reason" text NOT NULL,
  "status" "inv_slotting_recommendation_status" DEFAULT 'PENDING' NOT NULL,
  "transfer_id" integer,
  "decided_by" text,
  "decided_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_slotting_recommendations_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_slotting_recommendations_qty_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "fk_inv_slotting_rules_warehouse_org"
    FOREIGN KEY ("org_id", "warehouse_id") REFERENCES "inv_warehouses"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "fk_inv_slotting_rules_zone_org"
    FOREIGN KEY ("org_id", "target_zone_location_id") REFERENCES "inv_locations"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_category_id_fk"
    FOREIGN KEY ("category_id") REFERENCES "inv_categories"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_rules" ADD CONSTRAINT "inv_slotting_rules_product_variant_id_fk"
    FOREIGN KEY ("product_variant_id") REFERENCES "inv_product_variants"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_velocity_classes" ADD CONSTRAINT "inv_velocity_classes_warehouse_id_fk"
    FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_velocity_classes" ADD CONSTRAINT "fk_inv_velocity_variant_org"
    FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "inv_product_variants"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_warehouse_id_fk"
    FOREIGN KEY ("warehouse_id") REFERENCES "inv_warehouses"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "fk_inv_slotting_recommendation_variant_org"
    FOREIGN KEY ("org_id", "product_variant_id") REFERENCES "inv_product_variants"("org_id", "id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_from_location_id_fk"
    FOREIGN KEY ("from_location_id") REFERENCES "inv_locations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_to_zone_location_id_fk"
    FOREIGN KEY ("to_zone_location_id") REFERENCES "inv_locations"("id") ON DELETE cascade NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_rule_id_fk"
    FOREIGN KEY ("rule_id") REFERENCES "inv_slotting_rules"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "inv_slotting_recommendations" ADD CONSTRAINT "inv_slotting_recommendations_decided_by_users_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE set null NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "inv_slotting_rules_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "inv_slotting_rules_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "fk_inv_slotting_rules_warehouse_org";
--> statement-breakpoint
ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "fk_inv_slotting_rules_zone_org";
--> statement-breakpoint
ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "inv_slotting_rules_category_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_rules" VALIDATE CONSTRAINT "inv_slotting_rules_product_variant_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_velocity_classes" VALIDATE CONSTRAINT "inv_velocity_classes_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_velocity_classes" VALIDATE CONSTRAINT "inv_velocity_classes_warehouse_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_velocity_classes" VALIDATE CONSTRAINT "fk_inv_velocity_variant_org";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_warehouse_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "fk_inv_slotting_recommendation_variant_org";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_from_location_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_to_zone_location_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_rule_id_fk";
--> statement-breakpoint
ALTER TABLE "inv_slotting_recommendations" VALIDATE CONSTRAINT "inv_slotting_recommendations_decided_by_users_id_fk";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_slotting_rules_org_name"
  ON "inv_slotting_rules" ("org_id", "warehouse_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_slotting_rules_org_warehouse_active"
  ON "inv_slotting_rules" ("org_id", "warehouse_id", "priority") WHERE "is_active" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_velocity_org_warehouse_variant"
  ON "inv_velocity_classes" ("org_id", "warehouse_id", "product_variant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_velocity_org_warehouse_class"
  ON "inv_velocity_classes" ("org_id", "warehouse_id", "velocity_class");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_slotting_recommendation_open"
  ON "inv_slotting_recommendations" ("org_id", "product_variant_id", "from_location_id")
  WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_slotting_recommendations_org_status"
  ON "inv_slotting_recommendations" ("org_id", "warehouse_id", "status", "created_at");

SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-206. Packing validation could check that a package held no more than was
-- picked, and nothing about whether it would physically fit in a box. There was
-- no data to check against: no product carries a weight or a dimension, and
-- there is no catalogue of the cartons the warehouse actually stocks.
--
-- Measurements are integers in base units -- grams and millimetres -- rather
-- than decimals. A physical measure has no fractional gram worth modelling, and
-- integers cannot drift the way the quantity columns on this schema have
-- repeatedly been shown to.
CREATE TABLE IF NOT EXISTS "inv_carton_types" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "inner_length_mm" integer NOT NULL,
  "inner_width_mm" integer NOT NULL,
  "inner_height_mm" integer NOT NULL,
  "max_weight_grams" integer NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_inv_carton_types_org_code') THEN
    ALTER TABLE "inv_carton_types"
      ADD CONSTRAINT "uniq_inv_carton_types_org_code" UNIQUE ("org_id", "code");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_inv_carton_types_org_id') THEN
    ALTER TABLE "inv_carton_types"
      ADD CONSTRAINT "uniq_inv_carton_types_org_id" UNIQUE ("org_id", "id");
  END IF;
  -- A carton with no room is not a carton, and a zero divides into a fit
  -- calculation as a false yes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_carton_types_positive') THEN
    ALTER TABLE "inv_carton_types"
      ADD CONSTRAINT "chk_inv_carton_types_positive" CHECK (
        "inner_length_mm" > 0 AND "inner_width_mm" > 0
        AND "inner_height_mm" > 0 AND "max_weight_grams" > 0
      );
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_carton_types_org_active"
  ON "inv_carton_types" ("org_id", "is_active");
--> statement-breakpoint
-- Nullable: most catalogues do not measure everything, and a missing dimension
-- has to read as "unknown" rather than as zero. Zero would let anything fit.
ALTER TABLE "inv_product_variants" ADD COLUMN IF NOT EXISTS "weight_grams" integer;
--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD COLUMN IF NOT EXISTS "length_mm" integer;
--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD COLUMN IF NOT EXISTS "width_mm" integer;
--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD COLUMN IF NOT EXISTS "height_mm" integer;
--> statement-breakpoint
ALTER TABLE "inv_packages" ADD COLUMN IF NOT EXISTS "carton_type_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_packages_carton_type') THEN
    ALTER TABLE "inv_packages"
      ADD CONSTRAINT "fk_inv_packages_carton_type"
      FOREIGN KEY ("org_id", "carton_type_id")
      REFERENCES "inv_carton_types" ("org_id", "id") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_packages" VALIDATE CONSTRAINT "fk_inv_packages_carton_type";

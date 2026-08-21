-- 0406: Barcodes become a table. A single nullable non-unique column on product
-- and variant cannot hold multiple GTINs and is not uniquely resolvable per
-- tenant, so a scan resolves ambiguously. Exclusive arc per CLAUDE.md §19: a
-- barcode belongs to exactly one of product or variant.
-- The legacy inv_products.barcode / inv_product_variants.barcode columns are NOT
-- dropped here — they still back the barcode lookup service and are retired in
-- Phase 2 once that service reads this table.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TYPE "inv_barcode_type" AS ENUM ('GTIN', 'EAN13', 'UPC', 'CODE128', 'QR', 'OTHER');
--> statement-breakpoint

CREATE TABLE "inv_barcodes" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "product_id" integer,
  "product_variant_id" integer,
  "code" text NOT NULL,
  "barcode_type" "inv_barcode_type" DEFAULT 'GTIN' NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_barcodes_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_barcodes_exclusive_arc" CHECK (
    ("product_id" IS NOT NULL AND "product_variant_id" IS NULL)
    OR ("product_id" IS NULL AND "product_variant_id" IS NOT NULL)
  ),
  CONSTRAINT "fk_inv_barcodes_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_barcodes_product"
    FOREIGN KEY ("product_id") REFERENCES "inv_products" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_barcodes_variant"
    FOREIGN KEY ("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_barcodes_org_code" ON "inv_barcodes" ("org_id", "code");
--> statement-breakpoint
CREATE INDEX "idx_inv_barcodes_product" ON "inv_barcodes" ("org_id", "product_id");
--> statement-breakpoint
CREATE INDEX "idx_inv_barcodes_variant" ON "inv_barcodes" ("org_id", "product_variant_id");

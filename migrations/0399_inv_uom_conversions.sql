-- 0399: UoM conversion. A conversion factor belongs to the (product, uom) pair,
-- not to the unit — a case of widgets is 12, a case of bolts is 100. Document
-- lines keep both the entered quantity and its unit so a wrong factor stays
-- detectable after the fact; the ledger and snapshot are always base UoM.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "inv_product_uom_conversions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "product_id" integer NOT NULL,
  "uom_id" integer NOT NULL,
  "factor_to_base" numeric(18, 8) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_product_uom_conversions_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "chk_inv_product_uom_conversions_factor" CHECK ("factor_to_base" > 0),
  CONSTRAINT "fk_inv_product_uom_conversions_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_product_uom_conversions_org_product"
    FOREIGN KEY ("org_id", "product_id") REFERENCES "inv_products" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_product_uom_conversions_org_uom"
    FOREIGN KEY ("org_id", "uom_id") REFERENCES "inv_uom" ("org_id", "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_product_uom_conversions_key"
  ON "inv_product_uom_conversions" ("org_id", "product_id", "uom_id");
--> statement-breakpoint

CREATE INDEX "idx_inv_product_uom_conversions_product"
  ON "inv_product_uom_conversions" ("org_id", "product_id");
--> statement-breakpoint

ALTER TABLE "inv_po_lines"
  ADD COLUMN "uom_id" integer,
  ADD COLUMN "quantity_entered" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_po_lines"
  ADD CONSTRAINT "inv_po_lines_uom_id_inv_uom_id_fk"
  FOREIGN KEY ("uom_id") REFERENCES "inv_uom" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_po_lines" VALIDATE CONSTRAINT "inv_po_lines_uom_id_inv_uom_id_fk";
--> statement-breakpoint

ALTER TABLE "inv_grn_lines"
  ADD COLUMN "uom_id" integer,
  ADD COLUMN "quantity_entered" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_grn_lines"
  ADD CONSTRAINT "inv_grn_lines_uom_id_inv_uom_id_fk"
  FOREIGN KEY ("uom_id") REFERENCES "inv_uom" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "inv_grn_lines_uom_id_inv_uom_id_fk";
--> statement-breakpoint

ALTER TABLE "inv_so_lines"
  ADD COLUMN "uom_id" integer,
  ADD COLUMN "quantity_entered" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_so_lines"
  ADD CONSTRAINT "inv_so_lines_uom_id_inv_uom_id_fk"
  FOREIGN KEY ("uom_id") REFERENCES "inv_uom" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_so_lines" VALIDATE CONSTRAINT "inv_so_lines_uom_id_inv_uom_id_fk";
--> statement-breakpoint

ALTER TABLE "inv_stock_adjustment_lines"
  ADD COLUMN "uom_id" integer,
  ADD COLUMN "quantity_entered" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines"
  ADD CONSTRAINT "inv_stock_adjustment_lines_uom_id_inv_uom_id_fk"
  FOREIGN KEY ("uom_id") REFERENCES "inv_uom" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" VALIDATE CONSTRAINT "inv_stock_adjustment_lines_uom_id_inv_uom_id_fk";
--> statement-breakpoint

ALTER TABLE "inv_stock_transfer_lines"
  ADD COLUMN "uom_id" integer,
  ADD COLUMN "quantity_entered" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines"
  ADD CONSTRAINT "inv_stock_transfer_lines_uom_id_inv_uom_id_fk"
  FOREIGN KEY ("uom_id") REFERENCES "inv_uom" ("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" VALIDATE CONSTRAINT "inv_stock_transfer_lines_uom_id_inv_uom_id_fk";

-- 0402: Standard cost becomes effective-dated. inv_products.standard_cost is a
-- single scalar with no history, so a past valuation cannot be explained.
-- The column is NOT dropped here: it is still read by inv-reports-extended
-- (valuation), the products DTO and six frontend files. It is retired in Phase 2
-- once those readers move to this table.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "inv_standard_costs" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "product_variant_id" integer NOT NULL,
  "unit_cost" numeric(18, 4) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "notes" text,
  "created_by" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_standard_costs_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_standard_costs_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_standard_costs_variant"
    FOREIGN KEY ("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_standard_costs_created_by"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_standard_costs_variant_from"
  ON "inv_standard_costs" ("org_id", "product_variant_id", "effective_from");
--> statement-breakpoint
CREATE INDEX "idx_inv_standard_costs_lookup"
  ON "inv_standard_costs" ("org_id", "product_variant_id", "effective_from");

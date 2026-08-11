-- 0401: COGS becomes recordable. Layer consumption was previously an in-place
-- decrement of remaining_quantity with no record of which layers went, in what
-- quantity, at what cost — so historical COGS could not be reconstructed.
-- Weighted-average recomputations are likewise recorded, not just applied.

SET statement_timeout = 0;
SET lock_timeout = '5s';

CREATE TABLE "inv_valuation_consumptions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "stock_transaction_id" integer NOT NULL,
  "valuation_layer_id" integer NOT NULL,
  "quantity" numeric(18, 4) NOT NULL,
  "unit_cost" numeric(18, 4) NOT NULL,
  "total_cost" numeric(18, 4) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_valuation_consumptions_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_val_consumptions_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_val_consumptions_org_txn"
    FOREIGN KEY ("org_id", "stock_transaction_id") REFERENCES "inv_stock_transactions" ("org_id", "id"),
  CONSTRAINT "fk_inv_val_consumptions_org_layer"
    FOREIGN KEY ("org_id", "valuation_layer_id") REFERENCES "inv_valuation_layers" ("org_id", "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_val_consumptions_txn_layer"
  ON "inv_valuation_consumptions" ("org_id", "stock_transaction_id", "valuation_layer_id");
--> statement-breakpoint
CREATE INDEX "idx_inv_val_consumptions_org_txn"
  ON "inv_valuation_consumptions" ("org_id", "stock_transaction_id");
--> statement-breakpoint
CREATE INDEX "idx_inv_val_consumptions_org_layer"
  ON "inv_valuation_consumptions" ("org_id", "valuation_layer_id");
--> statement-breakpoint

CREATE TABLE "inv_average_cost_history" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" text NOT NULL,
  "product_variant_id" integer NOT NULL,
  "stock_transaction_id" integer NOT NULL,
  "quantity_before" numeric(18, 4) NOT NULL,
  "average_before" numeric(18, 4),
  "quantity_in" numeric(18, 4) NOT NULL,
  "unit_cost_in" numeric(18, 4) NOT NULL,
  "average_after" numeric(18, 4) NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uniq_inv_average_cost_history_org_id" UNIQUE ("org_id", "id"),
  CONSTRAINT "fk_inv_avg_cost_history_org"
    FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_avg_cost_history_variant"
    FOREIGN KEY ("product_variant_id") REFERENCES "inv_product_variants" ("id") ON DELETE CASCADE,
  CONSTRAINT "fk_inv_avg_cost_history_org_txn"
    FOREIGN KEY ("org_id", "stock_transaction_id") REFERENCES "inv_stock_transactions" ("org_id", "id")
);
--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_inv_avg_cost_history_txn"
  ON "inv_average_cost_history" ("org_id", "stock_transaction_id");
--> statement-breakpoint
CREATE INDEX "idx_inv_avg_cost_history_org_variant"
  ON "inv_average_cost_history" ("org_id", "product_variant_id", "created_at");

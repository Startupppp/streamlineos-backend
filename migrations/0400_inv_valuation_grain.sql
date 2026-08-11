-- 0400: Cost layers become location- and lot-aware (D-06). Without this an issue
-- from warehouse B consumes a layer created by a receipt into warehouse A, and
-- per-location valuation is impossible. The FIFO partial index is rebuilt to
-- lead with the new grain so consumption stays an index scan.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "inv_valuation_layers"
  ADD COLUMN "location_id" integer,
  ADD COLUMN "lot_id" integer;
--> statement-breakpoint

ALTER TABLE "inv_valuation_layers"
  ADD CONSTRAINT "inv_valuation_layers_location_id_inv_locations_id_fk"
  FOREIGN KEY ("location_id") REFERENCES "inv_locations" ("id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" VALIDATE CONSTRAINT "inv_valuation_layers_location_id_inv_locations_id_fk";
--> statement-breakpoint

ALTER TABLE "inv_valuation_layers"
  ADD CONSTRAINT "inv_valuation_layers_lot_id_inv_lots_id_fk"
  FOREIGN KEY ("lot_id") REFERENCES "inv_lots" ("id") ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" VALIDATE CONSTRAINT "inv_valuation_layers_lot_id_inv_lots_id_fk";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_inv_val_layers_fifo";
--> statement-breakpoint

CREATE INDEX "idx_inv_val_layers_fifo"
  ON "inv_valuation_layers" ("org_id", "product_variant_id", "location_id", "created_at")
  WHERE "remaining_quantity" > 0;

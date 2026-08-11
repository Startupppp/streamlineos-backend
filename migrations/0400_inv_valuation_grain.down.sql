-- 0400.down — Revert cost-layer grain; restores the pre-change FIFO index shape.
SET statement_timeout = 0;
SET lock_timeout = '5s';
DROP INDEX IF EXISTS "idx_inv_val_layers_fifo";
CREATE INDEX IF NOT EXISTS "idx_inv_val_layers_fifo"
  ON "inv_valuation_layers" ("org_id", "product_variant_id", "created_at")
  WHERE "remaining_quantity" > 0;
ALTER TABLE "inv_valuation_layers" DROP CONSTRAINT IF EXISTS "inv_valuation_layers_lot_id_inv_lots_id_fk";
ALTER TABLE "inv_valuation_layers" DROP CONSTRAINT IF EXISTS "inv_valuation_layers_location_id_inv_locations_id_fk";
ALTER TABLE "inv_valuation_layers" DROP COLUMN IF EXISTS "lot_id";
ALTER TABLE "inv_valuation_layers" DROP COLUMN IF EXISTS "location_id";

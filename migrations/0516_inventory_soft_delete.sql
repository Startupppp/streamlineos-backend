SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-107. DELETE /inventory/products/:productId physically deleted the row, and
-- inv_stock_transactions.product_variant_id carries ON DELETE CASCADE — so a
-- product that was received and then fully shipped nets to zero on hand, passes
-- the service's "has stock?" guard, and takes its entire movement history with
-- it, along with its lots, serials, valuation layers and cost history.
--
-- Proven in a rolled-back transaction: two ledger rows and one lot before the
-- delete, zero of each after.
--
-- The cascades stay. They are correct for a product that never existed
-- commercially, and rewriting sixteen foreign keys to RESTRICT would make the
-- catalogue unmaintainable. What changes is that deletion stops being physical:
-- deleted_at marks the row, every read filters it, and the ledger is never
-- reachable by that path.
ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;
--> statement-breakpoint
-- Partial, because every read excludes deleted rows and indexing them would
-- carry dead weight on the hot path.
CREATE INDEX IF NOT EXISTS "idx_inv_products_org_live"
  ON "inv_products" ("org_id", "id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_product_variants_org_live"
  ON "inv_product_variants" ("org_id", "id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- SKU uniqueness has to ignore deleted rows, or a deleted product holds its code
-- hostage forever. Tenant-scoped, never global: a bare unique index would let one
-- organisation's SKU block every other organisation's.
DROP INDEX IF EXISTS "uniq_inv_products_org_sku";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_products_org_sku_live"
  ON "inv_products" ("org_id", "sku") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_variants_org_sku";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_product_variants_org_sku_live"
  ON "inv_product_variants" ("org_id", "sku") WHERE "deleted_at" IS NULL;

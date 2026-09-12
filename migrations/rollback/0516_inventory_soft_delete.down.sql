-- 0516.down — Remove soft delete from products and variants.
--
-- Dropping deleted_at does not resurrect soft-deleted rows: it makes them
-- indistinguishable from live ones. Every product and variant a user deleted
-- reappears in every list the moment this runs, which is a data-visibility event
-- rather than a schema one, and is the reason this is declared.
--
-- The two "_live" partial unique indexes go with it -- a partial index on
-- deleted_at cannot outlive the column -- so SKU uniqueness reverts to whatever
-- unconditional index the chain has at that point.
--
-- @data-loss: inv_products, inv_product_variants
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_products_org_sku_live";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_product_variants_org_sku_live";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_products_org_live";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_inv_product_variants_org_live";
--> statement-breakpoint
ALTER TABLE "inv_products" DROP COLUMN IF EXISTS "deleted_at";
--> statement-breakpoint
ALTER TABLE "inv_product_variants" DROP COLUMN IF EXISTS "deleted_at";

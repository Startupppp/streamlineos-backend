SET lock_timeout = '5s';
--> statement-breakpoint
-- 0516 replaced the SKU uniqueness on products and variants with a *partial*
-- index excluding soft-deleted rows, so that archiving a product frees its SKU
-- for reuse. Both full indexes are back on the shared database, alongside the
-- partial ones they were replaced by, and the product-soft-delete spec fails on
-- exactly the behaviour 0516 bought: reusing a deleted SKU raises 23505 against
-- `uniq_inv_products_org_sku`.
--
-- Nobody reintroduced them by hand. `migrations/meta/0464_snapshot.json`
-- predates 0516, so `db:generate` diffs against a world where the full indexes
-- still exist and proposes recreating them; the generated migration then
-- reinstates precisely what 0516 removed. The Drizzle declaration in
-- `db/schema/inventory/core.ts` has only ever declared the partial ones, so the
-- declaration is right and the database is carrying the extras.
--
-- Dropping them is the repair. The generator will keep proposing them until the
-- snapshot is reconciled -- that is a separate job and is recorded as such --
-- so if these reappear, look at the snapshot before looking at this migration.
DROP INDEX IF EXISTS "uniq_inv_products_org_sku";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_variants_org_sku";

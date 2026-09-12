SET lock_timeout = '5s';
--> statement-breakpoint
-- A4. The same two indexes 0521 dropped are back on the shared database, for
-- the second time, and they defeat the thing they sit next to: with a *full*
-- unique index on (org_id, sku) beside the partial one, a soft-deleted SKU can
-- never be reused, which is the entire behaviour 0516 bought.
--
-- 0521 said to look at the snapshot before looking at the migration if they
-- reappeared, so that is what happened here. `migrations/meta/0464_snapshot.json`
-- is the newest snapshot and it still described the *full* indexes and knew
-- nothing of the partial ones, so every `db:generate` was diffing the schema
-- against a world where the replacement had never happened. That snapshot is
-- reconciled in this change; the Drizzle declaration in
-- `db/schema/inventory/core.ts` has only ever declared the partial ones and was
-- right all along.
--
-- If these come back a third time, the snapshot is no longer the explanation:
-- look for another branch's migration or a `db:push` against the shared
-- database, because nothing in this repository creates them any more.
DROP INDEX IF EXISTS "uniq_inv_products_org_sku";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_variants_org_sku";

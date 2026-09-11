SET lock_timeout = '5s';
--> statement-breakpoint

-- The full (org_id, sku) uniques are back for the **third** time, and this time
-- `0531` named the cause before it happened: "If these come back a third time,
-- the snapshot is no longer the explanation: look for another branch's migration
-- or a `db:push` against the shared database."
--
-- It is another branch's migrations -- two of them. Walking every create and
-- drop of these names in journal order says it plainly:
--
--     0000  CREATE      the baseline
--     0516  DROP        soft delete replaces them with partial ones
--     0521  DROP        back once
--     0531  DROP        back twice
--     0620  CREATE      control-plane chain
--     0624  CREATE      "sku uniqueness restored"
--
-- `0624`'s header says they are "declared in src/db/schema/inventory/core.ts
-- (lines 72 and 95)". They are not. That file declares only the partial ones --
-- `uniq_inv_products_org_sku_live` and `uniq_inv_product_variants_org_sku_live`,
-- both `WHERE deleted_at IS NULL` -- and says why in a comment beside them: a
-- deleted product must not hold its SKU hostage. Both 0620 and 0624 were
-- reading the drift, not the declaration.
--
-- Three drops have not held because each ran *before* a later create. This one
-- is ordered after both.
--
-- 0624's concern is real and is met by the partial indexes: an organisation
-- still cannot hold two *live* products with the same SKU. What the full index
-- adds on top is the thing `0516` bought soft delete to remove, and restoring a
-- retired SKU has failed against it ever since -- proven, not inferred, by
-- `test/inventory/product-restore.seeded-e2e-spec.ts` failing with
-- `duplicate key value violates unique constraint "uniq_inv_products_org_sku"`
-- on a cold-built merge of the two branches.
--
-- Ordered after main's tail on purpose: dropping these before 0620/0624 run
-- would simply let them put the indexes back, which is exactly how they
-- survived 0516, 0521 and 0531.
--
-- If they come back a *fourth* time, neither the snapshot nor a stray migration
-- is the explanation. Check `cell:compare-schema`'s reference schema -- it is
-- what 0624 was reconciling against, and it is the only remaining place that
-- still believes in the full indexes.

DROP INDEX IF EXISTS "uniq_inv_products_org_sku";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_variants_org_sku";
--> statement-breakpoint

-- The partial ones are what the declaration asks for; fail loudly rather than
-- leave a tenant with no SKU uniqueness at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_inv_products_org_sku_live'
  ) THEN
    RAISE EXCEPTION '0819: uniq_inv_products_org_sku_live is missing; refusing to leave inv_products without SKU uniqueness';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uniq_inv_product_variants_org_sku_live'
  ) THEN
    RAISE EXCEPTION '0819: uniq_inv_product_variants_org_sku_live is missing; refusing to leave inv_product_variants without SKU uniqueness';
  END IF;
END $$;

-- Restore the two tenant-scoped SKU uniqueness indexes to the control plane.
--
-- Both are declared in src/db/schema/inventory/core.ts (lines 72 and 95) and created by the
-- 0000 baseline, so a cold-built cell has them. The control plane had them at 4,417 indexes
-- and was at 4,415 half an hour later, with no migration in the chain that drops them. What
-- dropped them is not established -- anything that syncs the database toward a schema it does
-- not fully know about will remove objects like these.
--
-- Without them a single organization can hold two products with the same SKU. Verified before
-- restoring: 103 rows in each table, 0 duplicate (org_id, sku) groups, so the window closed
-- before anything used it.
--
-- Found by cell:compare-schema, which is the argument for running it on a schedule rather than
-- only when someone is building a cell.

--
-- indexes (2)
--
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_variants_org_sku ON public.inv_product_variants USING btree (org_id, sku);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_products_org_sku ON public.inv_products USING btree (org_id, sku);

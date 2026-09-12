-- 0574_inventory_party_columns: the three party columns nothing ever migrated.
--
-- `inv_sales_orders.client_party_id`, `inv_customer_returns.client_party_id` and
-- `inv_vendors.client_party_id` are declared in `src/db/schema/inventory/` —
-- `sales-orders.ts`, `operations.ts` and `purchase-orders.ts` each declare the
-- column *and* a composite foreign key to `business_parties` by name — and no
-- migration in this repository has ever created any of them. They exist on
-- databases that `drizzle-kit push` has touched, which is why nothing has
-- noticed, and they are absent from every database built by running migrations
-- in order.
--
-- That is what stopped a cold build at `0575_inventory_composite_tenant_fks`:
-- `column "client_party_id" referenced in foreign key constraint does not
-- exist`. `0575`–`0578` install the composite tenant foreign keys the whole
-- estate is being moved onto, and they were installing them against columns
-- nobody had migrated.
--
-- `0263`'s comment names this exact trap for `uniq_crm_organizations_org_id`
-- and says it is the third time it had appeared in that series. This is the
-- fourth, and the first where the missing object is a column rather than a
-- constraint.
--
-- Nullable, no backfill, no foreign key here. The column is what was missing;
-- the keys are `0575`'s job and it does them properly, `NOT VALID` first and
-- `VALIDATE` after. This file exists only so that there is something for those
-- keys to name.
--
-- Journalled immediately before `0575`, which is the only ordering that helps:
-- a file that adds a column has to run before the file that keys against it.
-- It shares the number `0574` with `0574_inventory_pharmacy_kirana_packs`,
-- which this repository already does in eight places — the journal decides
-- order, the number is a label. Nothing is disturbed by inserting here:
-- `0575`–`0579` have never successfully applied on any database, and
-- `db-bootstrap.mjs` skips by content hash rather than by position.
--
-- On a database `push` has touched the columns are already present and this is
-- three no-ops.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "inv_sales_orders"     ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ADD COLUMN IF NOT EXISTS "client_party_id" text;
--> statement-breakpoint
ALTER TABLE "inv_vendors"          ADD COLUMN IF NOT EXISTS "client_party_id" text;

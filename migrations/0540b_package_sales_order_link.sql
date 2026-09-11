-- 0540 — B6. A package has to know what it is packing.
--
-- `inv_packages` could be attributed to a shipment and to nothing else, and a
-- shipment does not exist until the order ships. So a package raised at the
-- packing bench — which is every package, because packing precedes shipping —
-- carried no link to the sales order whose goods were in it. Three things fell
-- out of that:
--
--   * `PackagesService.close` reconciled the contents against what was picked by
--     walking package → shipment → sales order, and the first hop was null for
--     every package that had not shipped yet. The check that exists to stop a
--     parcel going out with more units than anybody picked never ran on the path
--     it was written for.
--   * Nothing could answer "what is in this order's cartons so far", so a scan
--     at the bench had nothing to reconcile against and the packing queue could
--     only be read off the sales order's status.
--   * A wave-picked order was invisible twice over: `inv_pick_lists.so_id` is
--     null for a wave, so even where the shipment existed the picked quantities
--     came back empty.
--
-- Nullable, because a package genuinely need not belong to an order — a
-- transfer carton, or one raised against a shipment directly — and because
-- backfilling the existing rows would have to guess. `ON DELETE SET NULL`
-- matches `shipment_id`: deleting an order must not silently destroy the record
-- of a physical carton.
--
-- Locking, per §3 Migrations. `ADD COLUMN` with no default and no NOT NULL is a
-- catalogue-only change and takes its ACCESS EXCLUSIVE for microseconds. The
-- foreign key is the expensive half — it locks BOTH `inv_packages` and
-- `inv_sales_orders` for the whole validating scan — so it is added NOT VALID
-- and validated in its own statement, and `lock_timeout` makes a contended one
-- fail fast rather than queue with every write to either table behind it.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "inv_packages" ADD COLUMN IF NOT EXISTS "so_id" integer;
--> statement-breakpoint

-- The composite tenant key rather than a bare `so_id` reference: it is what
-- makes a cross-tenant parent impossible relationally rather than only by
-- predicate, and it is the form every other inventory document uses.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_inv_packages_so_id_org') THEN
    ALTER TABLE "inv_packages"
      ADD CONSTRAINT "fk_inv_packages_so_id_org"
      FOREIGN KEY ("org_id", "so_id")
      REFERENCES "inv_sales_orders" ("org_id", "id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "inv_packages" VALIDATE CONSTRAINT "fk_inv_packages_so_id_org";
--> statement-breakpoint

-- The packing bench's only query: the cartons standing against one order.
-- Partial, because most historical rows carry no order and indexing their nulls
-- buys nothing. Leading with `org_id` because RLS adds
-- `org_id = app.current_org_id()` to every read of this table.
CREATE INDEX IF NOT EXISTS "idx_inv_packages_org_so"
  ON "inv_packages" ("org_id", "so_id")
  WHERE "so_id" IS NOT NULL;

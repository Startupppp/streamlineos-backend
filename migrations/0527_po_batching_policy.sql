SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-309. Reorder proposals produced a bare quantity, and a bare quantity is
-- not an order. Suppliers sell in cases, refuse to ship below a minimum, and
-- charge for the privilege of a small order; rounding all of that at the last
-- moment -- or not at all -- is how a proposal for 7 units becomes a purchase
-- order the vendor rejects.
--
-- Both live on the product rather than on the vendor relationship, which is a
-- simplification worth naming: a product bought from two suppliers with
-- different case sizes needs a per-vendor record, and that is a bigger schema
-- decision than this ticket should make unilaterally.
ALTER TABLE "inv_products"
  ADD COLUMN IF NOT EXISTS "min_order_qty" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_products"
  ADD COLUMN IF NOT EXISTS "order_multiple" numeric(18, 4);
--> statement-breakpoint
DO $$
BEGIN
  -- Zero or negative would divide into the rounding as a false answer, and a
  -- multiple of zero is not a pack size.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_products_order_policy') THEN
    ALTER TABLE "inv_products"
      ADD CONSTRAINT "chk_inv_products_order_policy" CHECK (
        ("min_order_qty" IS NULL OR "min_order_qty" > 0)
        AND ("order_multiple" IS NULL OR "order_multiple" > 0)
      );
  END IF;
END $$;
--> statement-breakpoint
-- `require_po_approval` is a boolean: every order or none. A threshold is what
-- an approval policy actually looks like -- somebody signs off on the expensive
-- ones and stops rubber-stamping the rest, which is how the boolean version
-- ends up switched off entirely.
ALTER TABLE "inv_settings"
  ADD COLUMN IF NOT EXISTS "po_approval_threshold" numeric(18, 4);

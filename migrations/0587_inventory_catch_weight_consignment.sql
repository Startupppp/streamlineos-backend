-- NEO-10 and NEO-11 -- catch-weight, and stock that is not ours.
--
-- ## Catch-weight
--
-- A catch-weight SKU is *sold* by weight and *handled* in pieces, and the two do
-- not derive from each other. Two bags of chicken are two bags and 10.35 kg, and
-- the second bag weighing 5.10 kg is not an error to be corrected -- it is the
-- fact the invoice is raised on.
--
-- The ledger holds the **weight**, because that is the number that has to add up
-- across receipts and issues. `quantity_pieces` rides alongside on the document
-- for the person counting the bags. `inv_products.measure_mode` defaults to
-- PIECES, so every column here is inert until an organisation deliberately marks
-- a SKU as catch-weight.
--
-- ## Consignment
--
-- `ownership` says whose the stock is, and it joins the natural key of
-- `inv_stock_levels`: a consigned pallet and an owned one at the same bin are two
-- rows and stay tellable apart. Carrying it as a flag on the *product* instead
-- would make it impossible to hold both, which every consignment arrangement
-- eventually requires.
--
-- Only OWNED is available to promise and only OWNED is valued. Both gates live in
-- the canonical files -- `available-sql.ts`, `decimal.ts` and `valuation-sql.ts`
-- -- rather than in the callers, for the reason the transit gate does: a term
-- five call sites have to remember is a term one of them forgets, and forgetting
-- this one offers a supplier's goods for sale or puts them on our balance sheet.
--
-- `EXPECTED_COMMITTED` and `EXPECTED_OUTGOING` gain the same gate. A reservation
-- and a pick are always against owned stock, and without it one pick would empty
-- the consigned row's outgoing_qty as well as the owned one's -- the exact defect
-- `projection-definitions.ts` is a monument to, one grain deeper.
--
-- Taking title is its own explicit command, never a side effect of shipping: the
-- moment ownership transfers is the moment a liability to the supplier is
-- created, and a system that decided that on somebody's behalf would be inventing
-- an accounting event.
--
-- Backfill: none. `DEFAULT 'OWNED' NOT NULL` on a constant default is a metadata
-- change in Postgres 11 and later, and every existing row is owned -- which is
-- what all of it was.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_measure_mode" AS ENUM ('PIECES', 'CATCH_WEIGHT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "inv_ownership" AS ENUM ('OWNED', 'VENDOR', 'CUSTOMER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "inv_products" ADD COLUMN IF NOT EXISTS "measure_mode" "inv_measure_mode" DEFAULT 'PIECES' NOT NULL;
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "quantity_pieces" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD COLUMN IF NOT EXISTS "quantity_pieces" numeric(18, 4);
--> statement-breakpoint

ALTER TABLE "inv_grn_lines" ADD COLUMN IF NOT EXISTS "ownership" "inv_ownership" DEFAULT 'OWNED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" ADD COLUMN IF NOT EXISTS "ownership" "inv_ownership" DEFAULT 'OWNED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD COLUMN IF NOT EXISTS "ownership" "inv_ownership" DEFAULT 'OWNED' NOT NULL;
--> statement-breakpoint

-- The natural key again. Dropped and recreated because a unique index on an
-- expression cannot be extended in place; every existing row is OWNED, so the
-- new index enforces exactly the uniqueness the old one did.
DROP INDEX IF EXISTS "uniq_inv_stock_levels_natural_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_inv_stock_levels_natural_key"
  ON "inv_stock_levels" (
    "org_id", "product_variant_id", "location_id",
    coalesce("lot_id", 0), coalesce("serial_id", 0), coalesce("handling_unit_id", 0),
    "ownership"
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_stock_levels_org_ownership"
  ON "inv_stock_levels" ("org_id", "ownership", "product_variant_id")
  WHERE "ownership" <> 'OWNED';

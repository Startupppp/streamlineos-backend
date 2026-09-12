SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-104. Inventory had two CHECK constraints across sixty-six tables, so
-- every quantity invariant lived in service code and nothing stopped a second
-- writer from violating it.
--
-- The ledger's own arithmetic could not be asserted at all: a quality-hold or
-- block movement records a non-zero quantity_change while quantity_before and
-- quantity_after both hold the unchanged on-hand figure, so
-- after = before + change was simply false for those rows. quantity_bucket
-- makes the row say which bucket it moved, and before/after describe that
-- bucket, which is what lets the arithmetic become a database constraint
-- rather than a convention.
DO $$ BEGIN
  CREATE TYPE inv_quantity_bucket AS ENUM ('ON_HAND', 'BLOCKED', 'QUALITY_HOLD');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions"
  ADD COLUMN IF NOT EXISTS "quantity_bucket" inv_quantity_bucket NOT NULL DEFAULT 'ON_HAND';
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_stock_transactions_arithmetic'
                 AND conrelid = '"inv_stock_transactions"'::regclass) THEN
    ALTER TABLE "inv_stock_transactions"
      ADD CONSTRAINT "chk_inv_stock_transactions_arithmetic" CHECK ("quantity_after" = "quantity_before" + "quantity_change") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" VALIDATE CONSTRAINT "chk_inv_stock_transactions_arithmetic";
--> statement-breakpoint
-- A movement that moves nothing is not a fact worth recording, and it is the
-- shape a partially-built command produces.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_stock_transactions_nonzero'
                 AND conrelid = '"inv_stock_transactions"'::regclass) THEN
    ALTER TABLE "inv_stock_transactions"
      ADD CONSTRAINT "chk_inv_stock_transactions_nonzero" CHECK ("quantity_change" <> 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" VALIDATE CONSTRAINT "chk_inv_stock_transactions_nonzero";
--> statement-breakpoint
-- The reserved/blocked/held buckets are counts of physically present goods, so
-- they cannot go below zero whatever the negative-stock policy says about
-- on_hand. on_hand is deliberately excluded: a tenant may permit it negative.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_stock_levels_buckets_non_negative'
                 AND conrelid = '"inv_stock_levels"'::regclass) THEN
    ALTER TABLE "inv_stock_levels"
      ADD CONSTRAINT "chk_inv_stock_levels_buckets_non_negative" CHECK (
    "committed" >= 0
    AND COALESCE("blocked_qty", 0) >= 0
    AND COALESCE("quality_hold_qty", 0) >= 0
    AND COALESCE("outgoing_qty", 0) >= 0
    AND COALESCE("on_order", 0) >= 0
  ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_levels" VALIDATE CONSTRAINT "chk_inv_stock_levels_buckets_non_negative";
--> statement-breakpoint
-- A transfer to the location it came from is a no-op that still writes two
-- ledger rows and two projection updates.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_stock_transfers_distinct_endpoints'
                 AND conrelid = '"inv_stock_transfers"'::regclass) THEN
    ALTER TABLE "inv_stock_transfers"
      ADD CONSTRAINT "chk_inv_stock_transfers_distinct_endpoints" CHECK ("from_location_id" IS DISTINCT FROM "to_location_id") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" VALIDATE CONSTRAINT "chk_inv_stock_transfers_distinct_endpoints";
--> statement-breakpoint
-- Ordered, received, reserved and picked quantities are counts of goods.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_po_lines_quantities'
                 AND conrelid = '"inv_po_lines"'::regclass) THEN
    ALTER TABLE "inv_po_lines"
      ADD CONSTRAINT "chk_inv_po_lines_quantities" CHECK ("quantity" > 0 AND "quantity_received" >= 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_po_lines" VALIDATE CONSTRAINT "chk_inv_po_lines_quantities";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_so_lines_quantities'
                 AND conrelid = '"inv_so_lines"'::regclass) THEN
    ALTER TABLE "inv_so_lines"
      ADD CONSTRAINT "chk_inv_so_lines_quantities" CHECK ("quantity" > 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_so_lines" VALIDATE CONSTRAINT "chk_inv_so_lines_quantities";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_grn_lines_quantities'
                 AND conrelid = '"inv_grn_lines"'::regclass) THEN
    ALTER TABLE "inv_grn_lines"
      ADD CONSTRAINT "chk_inv_grn_lines_quantities" CHECK ("quantity_received" > 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines" VALIDATE CONSTRAINT "chk_inv_grn_lines_quantities";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_stock_transfer_lines_quantities'
                 AND conrelid = '"inv_stock_transfer_lines"'::regclass) THEN
    ALTER TABLE "inv_stock_transfer_lines"
      ADD CONSTRAINT "chk_inv_stock_transfer_lines_quantities" CHECK ("quantity" > 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" VALIDATE CONSTRAINT "chk_inv_stock_transfer_lines_quantities";
--> statement-breakpoint
-- A lot that expires before it was made is a data-entry error that FEFO would
-- then act on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_inv_lots_expiry_after_manufacture'
                 AND conrelid = '"inv_lots"'::regclass) THEN
    ALTER TABLE "inv_lots"
      ADD CONSTRAINT "chk_inv_lots_expiry_after_manufacture" CHECK ("expiry_date" IS NULL OR "manufacture_date" IS NULL OR "expiry_date" >= "manufacture_date") NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_lots" VALIDATE CONSTRAINT "chk_inv_lots_expiry_after_manufacture";

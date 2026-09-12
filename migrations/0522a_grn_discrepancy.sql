SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-201. A goods receipt recorded what arrived and nothing about what was
-- expected, so a short delivery was indistinguishable from a partial one that
-- everybody knew about. The PO line's running total could be differenced after
-- the fact, but only by replaying every receipt against it -- and by then the
-- receiver who saw the pallet has gone home.
--
-- `quantity_expected` snapshots what remained on the line at the moment of
-- receipt, alongside the UOM factor snapshot INV-106 already takes for the same
-- reason: a document should still be readable after the world moves under it.
--
-- `discrepancy_reason` is the receiver's answer to "why is this not what we
-- ordered". NULL means the line matched, which is the common case and should
-- cost nothing to record.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inv_grn_discrepancy') THEN
    CREATE TYPE "inv_grn_discrepancy" AS ENUM ('SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM');
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "inv_grn_lines"
  ADD COLUMN IF NOT EXISTS "quantity_expected" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "inv_grn_lines"
  ADD COLUMN IF NOT EXISTS "discrepancy_reason" "inv_grn_discrepancy";
--> statement-breakpoint
-- Reading "which receipts did not match" is the whole point of the column, and
-- it is a rare value in a table that grows with every delivery, so the index is
-- partial.
CREATE INDEX IF NOT EXISTS "idx_inv_grn_lines_discrepancy"
  ON "inv_grn_lines" ("org_id", "discrepancy_reason")
  WHERE "discrepancy_reason" IS NOT NULL;

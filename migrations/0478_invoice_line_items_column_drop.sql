-- c16-04: Remove invoices.line_items JSONB after verifying the table is authoritative.
-- Prerequisites: 0477 has run and invoice_items is fully populated.
--
-- Reconciliation check: aborts if any invoice whose items are tracked in the table
-- has a stored subtotal that differs from sum(invoice_items.amount) by more than 0.01.
-- invoice.total = subtotal + taxAmount - discount; we verify subtotal, the additive
-- component that derives directly from line amounts.
--
-- VACUUM ANALYZE invoices after this migration — the column drop changes the tuple
-- layout and query planners will see stale statistics until analysed.

SET lock_timeout = '5s';

-- PEND-DB: this file was one of fifteen missing from `_journal.json`, so it has
-- never run anywhere and is about to run everywhere. On a database where the
-- invoice line items cutover was completed by hand the column is already gone, and both
-- the verification block and the DROP below read it by name — so the whole file
-- is short-circuited when there is nothing left to drop. The guards themselves
-- are unchanged: where the column is present they still refuse rather than
-- destroy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'line_items'
  ) THEN
    RAISE NOTICE '0478: invoices.line_items is already gone; nothing to do.';
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  unmigrated_count int;
  mismatch_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'line_items') THEN
    RETURN;
  END IF;

  -- Guard 1: nothing may be left behind in the column being dropped.
  -- An invoice whose line_items JSONB is non-empty but which has NO invoice_items
  -- rows was never migrated. Guard 2 cannot see it -- an invoice with no rows is
  -- excluded by its own EXISTS clause -- so without this check the column would
  -- drop and that invoice's lines would be gone with no error.
  SELECT count(*) INTO unmigrated_count
  FROM invoices i
  WHERE i.line_items IS NOT NULL
    AND jsonb_array_length(i.line_items) > 0
    AND NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id);

  IF unmigrated_count > 0 THEN
    RAISE EXCEPTION
      'Unmigrated line items: % invoice(s) still carry a non-empty line_items JSONB with no invoice_items rows. Dropping the column would destroy them. Re-run 0477.',
      unmigrated_count;
  END IF;

  -- Guard 2: what was migrated reconciles against the stored subtotal.
  SELECT count(*) INTO mismatch_count
  FROM invoices i
  WHERE EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = i.id)
    AND abs(
          i.subtotal::numeric
          - (SELECT COALESCE(sum(ii.amount::numeric), 0) FROM invoice_items ii WHERE ii.invoice_id = i.id)
        ) > 0.01;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION
      'Total reconciliation failed: % invoice(s) have invoice_items sums that differ from stored subtotal by more than 0.01. Run 0477 and verify before re-attempting this migration.',
      mismatch_count;
  END IF;
END $$;

ALTER TABLE invoices DROP COLUMN IF EXISTS line_items;

-- Operator action required after this migration applies:
--   VACUUM ANALYZE invoices;

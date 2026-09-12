-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.


DO $g0$
BEGIN
  IF to_regclass('public."credit_note_items"') IS NOT NULL AND to_regclass('public."fin_payment_run_items"') IS NOT NULL AND to_regclass('public."vendor_credit_items"') IS NOT NULL THEN
    EXECUTE $s0$
CREATE INDEX IF NOT EXISTS idx_credit_note_items_org
  ON credit_note_items (org_id);

CREATE INDEX IF NOT EXISTS idx_fin_payment_run_items_org_run_status
  ON fin_payment_run_items (org_id, run_id, status);

CREATE INDEX IF NOT EXISTS idx_vendor_credit_items_org
  ON vendor_credit_items (org_id)
$s0$;
  END IF;
END $g0$;

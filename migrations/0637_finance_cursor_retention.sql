-- Guarded per table: some of the tables this names no longer exist.
--
-- The accounting rewrite replaced the pre-kernel finance tables and the party
-- migration replaced `leads`, and a statement against an absent table aborts the
-- whole migration. Each statement below now runs only if every table it names
-- exists — its target and anything it references. Where all of them are present
-- this is exactly the original file.


DO $g0$
BEGIN
  IF to_regclass('public."acc_tax_payments"') IS NOT NULL AND to_regclass('public."fin_reminder_log"') IS NOT NULL AND to_regclass('public."fin_reminder_policies"') IS NOT NULL THEN
    EXECUTE $s0$
ALTER TABLE acc_tax_payments
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_paid_date_id
  ON acc_tax_payments (org_id, paid_date, id);

ALTER TABLE fin_reminder_policies
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE fin_reminder_log
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_fin_reminder_log_org_sent_id
  ON fin_reminder_log (org_id, sent_at, id)
$s0$;
  END IF;
END $g0$;

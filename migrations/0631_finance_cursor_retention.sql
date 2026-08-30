ALTER TABLE acc_tax_payments
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_paid_date_id
  ON acc_tax_payments (org_id, paid_date, id);

ALTER TABLE fin_reminder_policies
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE fin_reminder_log
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_fin_reminder_log_org_sent_id
  ON fin_reminder_log (org_id, sent_at, id);

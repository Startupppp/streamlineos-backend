CREATE INDEX IF NOT EXISTS idx_credit_note_items_org
  ON credit_note_items (org_id);

CREATE INDEX IF NOT EXISTS idx_fin_payment_run_items_org_run_status
  ON fin_payment_run_items (org_id, run_id, status);

CREATE INDEX IF NOT EXISTS idx_vendor_credit_items_org
  ON vendor_credit_items (org_id);

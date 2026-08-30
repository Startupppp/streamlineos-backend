CREATE INDEX IF NOT EXISTS idx_invoices_org_duedate_status_id
  ON invoices (org_id, due_date, id)
  WHERE status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
    AND due_date IS NOT NULL;

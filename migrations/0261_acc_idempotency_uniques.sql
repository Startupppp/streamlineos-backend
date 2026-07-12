CREATE UNIQUE INDEX IF NOT EXISTS "uniq_fin_reminder_log_org_inv_offset" ON "fin_reminder_log" ("org_id", "invoice_id", "offset_days");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_acc_tax_payments_org_type_ref" ON "acc_tax_payments" ("org_id", "tax_type", "reference") WHERE "reference" IS NOT NULL;

-- 0964_ar02_canonical_tenant_fks_2 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.gl_accounts DROP CONSTRAINT IF EXISTS "fk_gl_accounts_book_id_org";
--> statement-breakpoint
ALTER TABLE public.fnf_settlements DROP CONSTRAINT IF EXISTS "fk_fnf_settlements_resignation_id_org";
--> statement-breakpoint
ALTER TABLE public.fnf_settlements
  ADD CONSTRAINT "fk_fnf_settlements_resignation_id_org"
  FOREIGN KEY (org_id, resignation_id)
  REFERENCES public.resignations (org_id, id)
  ON DELETE SET NULL (resignation_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT IF EXISTS "fk_fin_vendor_payment_allocations_vendor_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org"
  FOREIGN KEY (org_id, vendor_payment_id) REFERENCES vendor_payments(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT IF EXISTS "fk_fin_vendor_payment_allocations_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org"
  FOREIGN KEY (org_id, bill_id) REFERENCES purchase_bills(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log DROP CONSTRAINT IF EXISTS "fk_fin_reminder_log_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log
  ADD CONSTRAINT "fk_fin_reminder_log_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT IF EXISTS "fk_fin_reimbursement_batches_cash_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches DROP CONSTRAINT IF EXISTS "fk_fin_reconciliation_matches_bank_transaction_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches
  ADD CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org"
  FOREIGN KEY (org_id, bank_transaction_id) REFERENCES fin_bank_transactions(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items DROP CONSTRAINT IF EXISTS "fk_fin_payment_run_items_run_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items
  ADD CONSTRAINT "fk_fin_payment_run_items_run_id_org"
  FOREIGN KEY (org_id, run_id) REFERENCES fin_payment_runs(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT IF EXISTS "fk_fin_payment_allocations_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fk_fin_payment_allocations_payment_id_org"
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT IF EXISTS "fk_fin_payment_allocations_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fk_fin_payment_allocations_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies DROP CONSTRAINT IF EXISTS "fk_fin_expense_policies_category_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies
  ADD CONSTRAINT "fk_fin_expense_policies_category_id_org"
  FOREIGN KEY (org_id, category_id) REFERENCES expense_categories(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities DROP CONSTRAINT IF EXISTS "fk_fin_collection_activities_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities
  ADD CONSTRAINT "fk_fin_collection_activities_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions DROP CONSTRAINT IF EXISTS "fk_fin_budget_revisions_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions
  ADD CONSTRAINT "fk_fin_budget_revisions_budget_id_org"
  FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT IF EXISTS "fk_fin_budget_lines_department_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT IF EXISTS "fk_fin_budget_lines_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fk_fin_budget_lines_budget_id_org"
  FOREIGN KEY (org_id, budget_id) REFERENCES fin_budgets(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers DROP CONSTRAINT IF EXISTS "fk_fin_bank_transfers_to_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT IF EXISTS "fk_fin_bank_transactions_import_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fk_fin_bank_transactions_import_id_org"
  FOREIGN KEY (org_id, import_id) REFERENCES fin_bank_imports(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT IF EXISTS "fk_fin_bank_transactions_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org"
  FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports DROP CONSTRAINT IF EXISTS "fk_fin_bank_imports_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports
  ADD CONSTRAINT "fk_fin_bank_imports_bank_account_id_org"
  FOREIGN KEY (org_id, bank_account_id) REFERENCES fin_bank_accounts(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses DROP CONSTRAINT IF EXISTS "fk_feedback_cycle_responses_request_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses
  ADD CONSTRAINT "fk_feedback_cycle_responses_request_id_org"
  FOREIGN KEY (org_id, request_id)
  REFERENCES public.feedback_cycle_requests (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests DROP CONSTRAINT IF EXISTS "fk_feedback_cycle_requests_cycle_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests
  ADD CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES public.feedback_cycles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps DROP CONSTRAINT IF EXISTS "fk_email_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps
  ADD CONSTRAINT "fk_email_sequence_steps_sequence_id_org"
  FOREIGN KEY (org_id, sequence_id)
  REFERENCES public.email_sequences (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.dunning_attempts DROP CONSTRAINT IF EXISTS "fk_dunning_attempts_subscription_id_org";
--> statement-breakpoint
ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS "fk_documents_department_id_org";
--> statement-breakpoint
ALTER TABLE public.document_template_versions DROP CONSTRAINT IF EXISTS "fk_document_template_versions_template_id_org";
--> statement-breakpoint
ALTER TABLE public.document_template_versions
  ADD CONSTRAINT "fk_document_template_versions_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.document_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.coupon_redemptions DROP CONSTRAINT IF EXISTS "fk_coupon_redemptions_coupon_id_org";
--> statement-breakpoint
ALTER TABLE public.competencies DROP CONSTRAINT IF EXISTS "fk_competencies_framework_id_org";
--> statement-breakpoint
ALTER TABLE public.competencies
  ADD CONSTRAINT "fk_competencies_framework_id_org"
  FOREIGN KEY (org_id, framework_id)
  REFERENCES public.competency_frameworks (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.broadcast_read_receipts DROP CONSTRAINT IF EXISTS "fk_broadcast_read_receipts_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.broadcast_audience_targets DROP CONSTRAINT IF EXISTS "fk_broadcast_audience_targets_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_usage_rollup_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT IF EXISTS "fk_billing_invoice_line_snapshots_proration_line_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_credit_notes DROP CONSTRAINT IF EXISTS "fk_billing_credit_notes_original_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_credit_note_lines DROP CONSTRAINT IF EXISTS "fk_billing_credit_note_lines_credit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statements DROP CONSTRAINT IF EXISTS "fk_bank_statements_book_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statements DROP CONSTRAINT IF EXISTS "fk_bank_statements_bank_profile_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statement_lines DROP CONSTRAINT IF EXISTS "fk_bank_statement_lines_statement_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_profiles DROP CONSTRAINT IF EXISTS "fk_bank_profiles_book_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_profiles DROP CONSTRAINT IF EXISTS "fk_bank_profiles_account_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT IF EXISTS "fk_bank_matches_statement_line_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT IF EXISTS "fk_bank_matches_receipt_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT IF EXISTS "fk_bank_matches_payment_id_org";

-- AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part 2 of 7; the referential action of the single-column constraint being superseded is preserved.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "fk_bank_matches_payment_id_org"
  FOREIGN KEY (org_id, payment_id)
  REFERENCES public.ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches VALIDATE CONSTRAINT "fk_bank_matches_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "fk_bank_matches_receipt_id_org"
  FOREIGN KEY (org_id, receipt_id)
  REFERENCES public.ar_receipts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches VALIDATE CONSTRAINT "fk_bank_matches_receipt_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "fk_bank_matches_statement_line_id_org"
  FOREIGN KEY (org_id, statement_line_id)
  REFERENCES public.bank_statement_lines (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches VALIDATE CONSTRAINT "fk_bank_matches_statement_line_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_profiles
  ADD CONSTRAINT "fk_bank_profiles_account_id_org"
  FOREIGN KEY (org_id, account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_profiles VALIDATE CONSTRAINT "fk_bank_profiles_account_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_profiles
  ADD CONSTRAINT "fk_bank_profiles_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_profiles VALIDATE CONSTRAINT "fk_bank_profiles_book_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statement_lines
  ADD CONSTRAINT "fk_bank_statement_lines_statement_id_org"
  FOREIGN KEY (org_id, statement_id)
  REFERENCES public.bank_statements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statement_lines VALIDATE CONSTRAINT "fk_bank_statement_lines_statement_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statements
  ADD CONSTRAINT "fk_bank_statements_bank_profile_id_org"
  FOREIGN KEY (org_id, bank_profile_id)
  REFERENCES public.bank_profiles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statements VALIDATE CONSTRAINT "fk_bank_statements_bank_profile_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_statements
  ADD CONSTRAINT "fk_bank_statements_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statements VALIDATE CONSTRAINT "fk_bank_statements_book_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_credit_note_lines
  ADD CONSTRAINT "fk_billing_credit_note_lines_credit_note_id_org"
  FOREIGN KEY (org_id, credit_note_id)
  REFERENCES public.billing_credit_notes (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_credit_note_lines VALIDATE CONSTRAINT "fk_billing_credit_note_lines_credit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_credit_notes
  ADD CONSTRAINT "fk_billing_credit_notes_original_snapshot_id_org"
  FOREIGN KEY (org_id, original_snapshot_id)
  REFERENCES public.billing_invoice_snapshots (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_credit_notes VALIDATE CONSTRAINT "fk_billing_credit_notes_original_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "fk_billing_invoice_line_snapshots_proration_line_id_org"
  FOREIGN KEY (org_id, proration_line_id)
  REFERENCES public.billing_proration_lines (org_id, id)
  ON DELETE SET NULL (proration_line_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots VALIDATE CONSTRAINT "fk_billing_invoice_line_snapshots_proration_line_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "fk_billing_invoice_line_snapshots_snapshot_id_org"
  FOREIGN KEY (org_id, snapshot_id)
  REFERENCES public.billing_invoice_snapshots (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots VALIDATE CONSTRAINT "fk_billing_invoice_line_snapshots_snapshot_id_org";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "fk_billing_invoice_line_snapshots_usage_rollup_id_org"
  FOREIGN KEY (org_id, usage_rollup_id)
  REFERENCES public.billing_usage_rollups (org_id, id)
  ON DELETE SET NULL (usage_rollup_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots VALIDATE CONSTRAINT "fk_billing_invoice_line_snapshots_usage_rollup_id_org";
--> statement-breakpoint
ALTER TABLE public.broadcast_audience_targets
  ADD CONSTRAINT "fk_broadcast_audience_targets_broadcast_id_org"
  FOREIGN KEY (org_id, broadcast_id)
  REFERENCES public.broadcasts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.broadcast_audience_targets VALIDATE CONSTRAINT "fk_broadcast_audience_targets_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.broadcast_read_receipts
  ADD CONSTRAINT "fk_broadcast_read_receipts_broadcast_id_org"
  FOREIGN KEY (org_id, broadcast_id)
  REFERENCES public.broadcasts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.broadcast_read_receipts VALIDATE CONSTRAINT "fk_broadcast_read_receipts_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.competencies DROP CONSTRAINT "fk_competencies_framework_id_org";
--> statement-breakpoint
ALTER TABLE public.competencies
  ADD CONSTRAINT "fk_competencies_framework_id_org"
  FOREIGN KEY (org_id, framework_id)
  REFERENCES public.competency_frameworks (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.competencies VALIDATE CONSTRAINT "fk_competencies_framework_id_org";
--> statement-breakpoint
ALTER TABLE public.coupon_redemptions
  ADD CONSTRAINT "fk_coupon_redemptions_coupon_id_org"
  FOREIGN KEY (org_id, coupon_id)
  REFERENCES public.coupons (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.coupon_redemptions VALIDATE CONSTRAINT "fk_coupon_redemptions_coupon_id_org";
--> statement-breakpoint
ALTER TABLE public.document_template_versions DROP CONSTRAINT "fk_document_template_versions_template_id_org";
--> statement-breakpoint
ALTER TABLE public.document_template_versions
  ADD CONSTRAINT "fk_document_template_versions_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.document_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.document_template_versions VALIDATE CONSTRAINT "fk_document_template_versions_template_id_org";
--> statement-breakpoint
ALTER TABLE public.documents
  ADD CONSTRAINT "fk_documents_department_id_org"
  FOREIGN KEY (org_id, department_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.documents VALIDATE CONSTRAINT "fk_documents_department_id_org";
--> statement-breakpoint
ALTER TABLE public.dunning_attempts
  ADD CONSTRAINT "fk_dunning_attempts_subscription_id_org"
  FOREIGN KEY (org_id, subscription_id)
  REFERENCES public.subscriptions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.dunning_attempts VALIDATE CONSTRAINT "fk_dunning_attempts_subscription_id_org";
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps DROP CONSTRAINT "fk_email_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps
  ADD CONSTRAINT "fk_email_sequence_steps_sequence_id_org"
  FOREIGN KEY (org_id, sequence_id)
  REFERENCES public.email_sequences (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps VALIDATE CONSTRAINT "fk_email_sequence_steps_sequence_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests DROP CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests
  ADD CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org"
  FOREIGN KEY (org_id, cycle_id)
  REFERENCES public.feedback_cycles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests VALIDATE CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses DROP CONSTRAINT "fk_feedback_cycle_responses_request_id_org";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses
  ADD CONSTRAINT "fk_feedback_cycle_responses_request_id_org"
  FOREIGN KEY (org_id, request_id)
  REFERENCES public.feedback_cycle_requests (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses VALIDATE CONSTRAINT "fk_feedback_cycle_responses_request_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports DROP CONSTRAINT "fk_fin_bank_imports_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports
  ADD CONSTRAINT "fk_fin_bank_imports_bank_account_id_org"
  FOREIGN KEY (org_id, bank_account_id)
  REFERENCES public.fin_bank_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports VALIDATE CONSTRAINT "fk_fin_bank_imports_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org"
  FOREIGN KEY (org_id, bank_account_id)
  REFERENCES public.fin_bank_accounts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions VALIDATE CONSTRAINT "fk_fin_bank_transactions_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT "fk_fin_bank_transactions_import_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fk_fin_bank_transactions_import_id_org"
  FOREIGN KEY (org_id, import_id)
  REFERENCES public.fin_bank_imports (org_id, id)
  ON DELETE SET NULL (import_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions VALIDATE CONSTRAINT "fk_fin_bank_transactions_import_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers
  ADD CONSTRAINT "fk_fin_bank_transfers_to_bank_account_id_org"
  FOREIGN KEY (org_id, to_bank_account_id)
  REFERENCES public.fin_bank_accounts (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers VALIDATE CONSTRAINT "fk_fin_bank_transfers_to_bank_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT "fk_fin_budget_lines_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fk_fin_budget_lines_budget_id_org"
  FOREIGN KEY (org_id, budget_id)
  REFERENCES public.fin_budgets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines VALIDATE CONSTRAINT "fk_fin_budget_lines_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fk_fin_budget_lines_department_id_org"
  FOREIGN KEY (org_id, department_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines VALIDATE CONSTRAINT "fk_fin_budget_lines_department_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions DROP CONSTRAINT "fk_fin_budget_revisions_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions
  ADD CONSTRAINT "fk_fin_budget_revisions_budget_id_org"
  FOREIGN KEY (org_id, budget_id)
  REFERENCES public.fin_budgets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions VALIDATE CONSTRAINT "fk_fin_budget_revisions_budget_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities DROP CONSTRAINT "fk_fin_collection_activities_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities
  ADD CONSTRAINT "fk_fin_collection_activities_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE SET NULL (invoice_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities VALIDATE CONSTRAINT "fk_fin_collection_activities_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies DROP CONSTRAINT "fk_fin_expense_policies_category_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies
  ADD CONSTRAINT "fk_fin_expense_policies_category_id_org"
  FOREIGN KEY (org_id, category_id)
  REFERENCES public.expense_categories (org_id, id)
  ON DELETE SET NULL (category_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies VALIDATE CONSTRAINT "fk_fin_expense_policies_category_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT "fk_fin_payment_allocations_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fk_fin_payment_allocations_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations VALIDATE CONSTRAINT "fk_fin_payment_allocations_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT "fk_fin_payment_allocations_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fk_fin_payment_allocations_payment_id_org"
  FOREIGN KEY (org_id, payment_id)
  REFERENCES public.payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations VALIDATE CONSTRAINT "fk_fin_payment_allocations_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items DROP CONSTRAINT "fk_fin_payment_run_items_run_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items
  ADD CONSTRAINT "fk_fin_payment_run_items_run_id_org"
  FOREIGN KEY (org_id, run_id)
  REFERENCES public.fin_payment_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items VALIDATE CONSTRAINT "fk_fin_payment_run_items_run_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches DROP CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches
  ADD CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org"
  FOREIGN KEY (org_id, bank_transaction_id)
  REFERENCES public.fin_bank_transactions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches VALIDATE CONSTRAINT "fk_fin_reconciliation_matches_bank_transaction_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fk_fin_reimbursement_batches_cash_account_id_org"
  FOREIGN KEY (org_id, cash_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE SET NULL (cash_account_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_cash_account_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fk_fin_reimbursement_batches_posted_journal_id_org"
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE SET NULL (posted_journal_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches VALIDATE CONSTRAINT "fk_fin_reimbursement_batches_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log DROP CONSTRAINT "fk_fin_reminder_log_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log
  ADD CONSTRAINT "fk_fin_reminder_log_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log VALIDATE CONSTRAINT "fk_fin_reminder_log_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org"
  FOREIGN KEY (org_id, bill_id)
  REFERENCES public.purchase_bills (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations VALIDATE CONSTRAINT "fk_fin_vendor_payment_allocations_bill_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org"
  FOREIGN KEY (org_id, vendor_payment_id)
  REFERENCES public.vendor_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations VALIDATE CONSTRAINT "fk_fin_vendor_payment_allocations_vendor_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.fnf_settlements DROP CONSTRAINT "fk_fnf_settlements_resignation_id_org";
--> statement-breakpoint
ALTER TABLE public.fnf_settlements
  ADD CONSTRAINT "fk_fnf_settlements_resignation_id_org"
  FOREIGN KEY (org_id, resignation_id)
  REFERENCES public.resignations (org_id, id)
  ON DELETE SET NULL (resignation_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fnf_settlements VALIDATE CONSTRAINT "fk_fnf_settlements_resignation_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_accounts
  ADD CONSTRAINT "fk_gl_accounts_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;

-- AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part 1 of 7; the referential action of the single-column constraint being superseded is preserved.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories
  ADD CONSTRAINT "fk_acc_asset_categories_accumulated_depreciation_account_id_org"
  FOREIGN KEY (org_id, accumulated_depreciation_account_id)
  REFERENCES public.ledger_accounts (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories VALIDATE CONSTRAINT "fk_acc_asset_categories_accumulated_depreciation_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories
  ADD CONSTRAINT "fk_acc_asset_categories_depreciation_expense_account_id_org"
  FOREIGN KEY (org_id, depreciation_expense_account_id)
  REFERENCES public.ledger_accounts (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories VALIDATE CONSTRAINT "fk_acc_asset_categories_depreciation_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules DROP CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules
  ADD CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org"
  FOREIGN KEY (org_id, asset_id)
  REFERENCES public.acc_fixed_assets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules VALIDATE CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map DROP CONSTRAINT "fk_acc_system_account_map_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map
  ADD CONSTRAINT "fk_acc_system_account_map_account_id_org"
  FOREIGN KEY (org_id, account_id)
  REFERENCES public.ledger_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map VALIDATE CONSTRAINT "fk_acc_system_account_map_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes
  ADD CONSTRAINT "fk_acc_tax_codes_paid_account_id_org"
  FOREIGN KEY (org_id, paid_account_id)
  REFERENCES public.ledger_accounts (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes VALIDATE CONSTRAINT "fk_acc_tax_codes_paid_account_id_org";
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values DROP CONSTRAINT "fk_accounting_dimension_values_dimension_id_org";
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values
  ADD CONSTRAINT "fk_accounting_dimension_values_dimension_id_org"
  FOREIGN KEY (org_id, dimension_id)
  REFERENCES public.accounting_dimensions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values VALIDATE CONSTRAINT "fk_accounting_dimension_values_dimension_id_org";
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages DROP CONSTRAINT "fk_ai_chat_messages_conversation_id_org";
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages
  ADD CONSTRAINT "fk_ai_chat_messages_conversation_id_org"
  FOREIGN KEY (org_id, conversation_id)
  REFERENCES public.ai_chat_conversations (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages VALIDATE CONSTRAINT "fk_ai_chat_messages_conversation_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_reads DROP CONSTRAINT "fk_announcement_reads_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_reads
  ADD CONSTRAINT "fk_announcement_reads_announcement_id_org"
  FOREIGN KEY (org_id, announcement_id)
  REFERENCES public.announcements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.announcement_reads VALIDATE CONSTRAINT "fk_announcement_reads_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_targets DROP CONSTRAINT "fk_announcement_targets_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_targets
  ADD CONSTRAINT "fk_announcement_targets_announcement_id_org"
  FOREIGN KEY (org_id, announcement_id)
  REFERENCES public.announcements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.announcement_targets VALIDATE CONSTRAINT "fk_announcement_targets_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "fk_ap_allocations_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations VALIDATE CONSTRAINT "fk_ap_allocations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "fk_ap_allocations_debit_note_id_org"
  FOREIGN KEY (org_id, debit_note_id)
  REFERENCES public.ap_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations VALIDATE CONSTRAINT "fk_ap_allocations_debit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "fk_ap_allocations_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.ap_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations VALIDATE CONSTRAINT "fk_ap_allocations_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "fk_ap_allocations_payment_id_org"
  FOREIGN KEY (org_id, payment_id)
  REFERENCES public.ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations VALIDATE CONSTRAINT "fk_ap_allocations_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines
  ADD CONSTRAINT "fk_ap_document_lines_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.ap_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_document_lines VALIDATE CONSTRAINT "fk_ap_document_lines_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines
  ADD CONSTRAINT "fk_ap_document_lines_expense_account_id_org"
  FOREIGN KEY (org_id, expense_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_document_lines VALIDATE CONSTRAINT "fk_ap_document_lines_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "fk_ap_documents_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents VALIDATE CONSTRAINT "fk_ap_documents_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "fk_ap_documents_original_document_id_org"
  FOREIGN KEY (org_id, original_document_id)
  REFERENCES public.ap_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents VALIDATE CONSTRAINT "fk_ap_documents_original_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "fk_ap_documents_party_id_org"
  FOREIGN KEY (org_id, party_id)
  REFERENCES public.gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents VALIDATE CONSTRAINT "fk_ap_documents_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "fk_ap_documents_posted_journal_id_org"
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents VALIDATE CONSTRAINT "fk_ap_documents_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "fk_ap_payments_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments VALIDATE CONSTRAINT "fk_ap_payments_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "fk_ap_payments_party_id_org"
  FOREIGN KEY (org_id, party_id)
  REFERENCES public.gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments VALIDATE CONSTRAINT "fk_ap_payments_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "fk_ap_payments_payment_account_id_org"
  FOREIGN KEY (org_id, payment_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments VALIDATE CONSTRAINT "fk_ap_payments_payment_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "fk_ap_payments_posted_journal_id_org"
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments VALIDATE CONSTRAINT "fk_ap_payments_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "fk_ap_payments_reversal_journal_id_org"
  FOREIGN KEY (org_id, reversal_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments VALIDATE CONSTRAINT "fk_ap_payments_reversal_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "fk_ap_withholding_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding VALIDATE CONSTRAINT "fk_ap_withholding_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "fk_ap_withholding_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.ap_documents (org_id, id)
  ON DELETE SET NULL (document_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding VALIDATE CONSTRAINT "fk_ap_withholding_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "fk_ap_withholding_gl_account_id_org"
  FOREIGN KEY (org_id, gl_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding VALIDATE CONSTRAINT "fk_ap_withholding_gl_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "fk_ap_withholding_payment_id_org"
  FOREIGN KEY (org_id, payment_id)
  REFERENCES public.ap_payments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding VALIDATE CONSTRAINT "fk_ap_withholding_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "fk_ar_allocations_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations VALIDATE CONSTRAINT "fk_ar_allocations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "fk_ar_allocations_credit_note_id_org"
  FOREIGN KEY (org_id, credit_note_id)
  REFERENCES public.ar_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations VALIDATE CONSTRAINT "fk_ar_allocations_credit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "fk_ar_allocations_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.ar_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations VALIDATE CONSTRAINT "fk_ar_allocations_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "fk_ar_allocations_receipt_id_org"
  FOREIGN KEY (org_id, receipt_id)
  REFERENCES public.ar_receipts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations VALIDATE CONSTRAINT "fk_ar_allocations_receipt_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines
  ADD CONSTRAINT "fk_ar_document_lines_document_id_org"
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.ar_documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_document_lines VALIDATE CONSTRAINT "fk_ar_document_lines_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines
  ADD CONSTRAINT "fk_ar_document_lines_income_account_id_org"
  FOREIGN KEY (org_id, income_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_document_lines VALIDATE CONSTRAINT "fk_ar_document_lines_income_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "fk_ar_documents_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents VALIDATE CONSTRAINT "fk_ar_documents_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "fk_ar_documents_original_document_id_org"
  FOREIGN KEY (org_id, original_document_id)
  REFERENCES public.ar_documents (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents VALIDATE CONSTRAINT "fk_ar_documents_original_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "fk_ar_documents_party_id_org"
  FOREIGN KEY (org_id, party_id)
  REFERENCES public.gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents VALIDATE CONSTRAINT "fk_ar_documents_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "fk_ar_documents_posted_journal_id_org"
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents VALIDATE CONSTRAINT "fk_ar_documents_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "fk_ar_receipts_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts VALIDATE CONSTRAINT "fk_ar_receipts_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "fk_ar_receipts_deposit_account_id_org"
  FOREIGN KEY (org_id, deposit_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts VALIDATE CONSTRAINT "fk_ar_receipts_deposit_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "fk_ar_receipts_party_id_org"
  FOREIGN KEY (org_id, party_id)
  REFERENCES public.gl_parties (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts VALIDATE CONSTRAINT "fk_ar_receipts_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "fk_ar_receipts_posted_journal_id_org"
  FOREIGN KEY (org_id, posted_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts VALIDATE CONSTRAINT "fk_ar_receipts_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "fk_ar_receipts_reversal_journal_id_org"
  FOREIGN KEY (org_id, reversal_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts VALIDATE CONSTRAINT "fk_ar_receipts_reversal_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.assessment_attempts DROP CONSTRAINT "fk_assessment_attempts_assessment_id_org";
--> statement-breakpoint
ALTER TABLE public.assessment_attempts
  ADD CONSTRAINT "fk_assessment_attempts_assessment_id_org"
  FOREIGN KEY (org_id, assessment_id)
  REFERENCES public.skill_assessments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assessment_attempts VALIDATE CONSTRAINT "fk_assessment_attempts_assessment_id_org";
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state DROP CONSTRAINT "fk_assignment_rule_state_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state
  ADD CONSTRAINT "fk_assignment_rule_state_rule_id_org"
  FOREIGN KEY (org_id, rule_id)
  REFERENCES public.lead_assignment_rules (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state VALIDATE CONSTRAINT "fk_assignment_rule_state_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.automation_runs DROP CONSTRAINT "fk_automation_runs_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.automation_runs
  ADD CONSTRAINT "fk_automation_runs_rule_id_org"
  FOREIGN KEY (org_id, rule_id)
  REFERENCES public.automation_rules (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.automation_runs VALIDATE CONSTRAINT "fk_automation_runs_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "fk_bank_matches_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches VALIDATE CONSTRAINT "fk_bank_matches_book_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "fk_bank_matches_journal_id_org"
  FOREIGN KEY (org_id, journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches VALIDATE CONSTRAINT "fk_bank_matches_journal_id_org";

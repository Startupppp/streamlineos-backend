-- 0963_ar02_canonical_tenant_fks_1 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT IF EXISTS "fk_bank_matches_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT IF EXISTS "fk_bank_matches_book_id_org";
--> statement-breakpoint
ALTER TABLE public.automation_runs DROP CONSTRAINT IF EXISTS "fk_automation_runs_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.automation_runs
  ADD CONSTRAINT "fk_automation_runs_rule_id_org"
  FOREIGN KEY (org_id, rule_id)
  REFERENCES public.automation_rules (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state DROP CONSTRAINT IF EXISTS "fk_assignment_rule_state_rule_id_org";
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state
  ADD CONSTRAINT "fk_assignment_rule_state_rule_id_org"
  FOREIGN KEY (org_id, rule_id)
  REFERENCES public.lead_assignment_rules (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assessment_attempts DROP CONSTRAINT IF EXISTS "fk_assessment_attempts_assessment_id_org";
--> statement-breakpoint
ALTER TABLE public.assessment_attempts
  ADD CONSTRAINT "fk_assessment_attempts_assessment_id_org"
  FOREIGN KEY (org_id, assessment_id)
  REFERENCES public.skill_assessments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT IF EXISTS "fk_ar_receipts_reversal_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT IF EXISTS "fk_ar_receipts_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT IF EXISTS "fk_ar_receipts_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT IF EXISTS "fk_ar_receipts_deposit_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT IF EXISTS "fk_ar_receipts_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT IF EXISTS "fk_ar_documents_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT IF EXISTS "fk_ar_documents_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT IF EXISTS "fk_ar_documents_original_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT IF EXISTS "fk_ar_documents_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines DROP CONSTRAINT IF EXISTS "fk_ar_document_lines_income_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines DROP CONSTRAINT IF EXISTS "fk_ar_document_lines_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT IF EXISTS "fk_ar_allocations_receipt_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT IF EXISTS "fk_ar_allocations_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT IF EXISTS "fk_ar_allocations_credit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT IF EXISTS "fk_ar_allocations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT IF EXISTS "fk_ap_withholding_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT IF EXISTS "fk_ap_withholding_gl_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT IF EXISTS "fk_ap_withholding_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT IF EXISTS "fk_ap_withholding_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT IF EXISTS "fk_ap_payments_reversal_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT IF EXISTS "fk_ap_payments_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT IF EXISTS "fk_ap_payments_payment_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT IF EXISTS "fk_ap_payments_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT IF EXISTS "fk_ap_payments_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT IF EXISTS "fk_ap_documents_posted_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT IF EXISTS "fk_ap_documents_party_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT IF EXISTS "fk_ap_documents_original_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT IF EXISTS "fk_ap_documents_book_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines DROP CONSTRAINT IF EXISTS "fk_ap_document_lines_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines DROP CONSTRAINT IF EXISTS "fk_ap_document_lines_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT IF EXISTS "fk_ap_allocations_payment_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT IF EXISTS "fk_ap_allocations_document_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT IF EXISTS "fk_ap_allocations_debit_note_id_org";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT IF EXISTS "fk_ap_allocations_book_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_targets DROP CONSTRAINT IF EXISTS "fk_announcement_targets_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_targets
  ADD CONSTRAINT "fk_announcement_targets_announcement_id_org"
  FOREIGN KEY (org_id, announcement_id)
  REFERENCES public.announcements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.announcement_reads DROP CONSTRAINT IF EXISTS "fk_announcement_reads_announcement_id_org";
--> statement-breakpoint
ALTER TABLE public.announcement_reads
  ADD CONSTRAINT "fk_announcement_reads_announcement_id_org"
  FOREIGN KEY (org_id, announcement_id)
  REFERENCES public.announcements (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages DROP CONSTRAINT IF EXISTS "fk_ai_chat_messages_conversation_id_org";
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages
  ADD CONSTRAINT "fk_ai_chat_messages_conversation_id_org"
  FOREIGN KEY (org_id, conversation_id)
  REFERENCES public.ai_chat_conversations (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values DROP CONSTRAINT IF EXISTS "fk_accounting_dimension_values_dimension_id_org";
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values
  ADD CONSTRAINT "fk_accounting_dimension_values_dimension_id_org"
  FOREIGN KEY (org_id, dimension_id) REFERENCES accounting_dimensions(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes DROP CONSTRAINT IF EXISTS "fk_acc_tax_codes_paid_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map DROP CONSTRAINT IF EXISTS "fk_acc_system_account_map_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map
  ADD CONSTRAINT "fk_acc_system_account_map_account_id_org"
  FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules DROP CONSTRAINT IF EXISTS "fk_acc_depreciation_schedules_asset_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules
  ADD CONSTRAINT "fk_acc_depreciation_schedules_asset_id_org"
  FOREIGN KEY (org_id, asset_id) REFERENCES acc_fixed_assets(org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories DROP CONSTRAINT IF EXISTS "fk_acc_asset_categories_depreciation_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories DROP CONSTRAINT IF EXISTS "fk_acc_asset_categories_accumulated_depreciation_account_id_org";

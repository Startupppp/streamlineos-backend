-- 0970_ar02_drop_superseded_tenant_fks_1 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.expenses
  ADD CONSTRAINT "expenses_posted_journal_entry_id_journal_entries_id_fk"
  FOREIGN KEY (posted_journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.expense_categories
  ADD CONSTRAINT "expense_categories_ledger_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (ledger_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.exit_checklists
  ADD CONSTRAINT "fk_exit_checklists_resignation_id_org"
  FOREIGN KEY (org_id, resignation_id) REFERENCES public.resignations (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.exit_checklists
  ADD CONSTRAINT "exit_checklists_resignation_id_resignations_id_fk"
  FOREIGN KEY (resignation_id) REFERENCES public.resignations (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps
  ADD CONSTRAINT "email_sequence_steps_sequence_id_email_sequences_id_fk"
  FOREIGN KEY (sequence_id) REFERENCES public.email_sequences (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.dunning_attempts
  ADD CONSTRAINT "dunning_attempts_subscription_id_subscriptions_id_fk"
  FOREIGN KEY (subscription_id) REFERENCES public.subscriptions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.documents
  ADD CONSTRAINT "fk_documents_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.document_template_versions
  ADD CONSTRAINT "document_template_versions_template_id_document_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES public.document_templates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.document_audit_logs
  ADD CONSTRAINT "document_audit_logs_onboarding_document_id_onboarding_documents"
  FOREIGN KEY (onboarding_document_id) REFERENCES public.onboarding_documents (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.coupon_redemptions
  ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk"
  FOREIGN KEY (coupon_id) REFERENCES public.coupons (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.competencies
  ADD CONSTRAINT "competencies_framework_id_competency_frameworks_id_fk"
  FOREIGN KEY (framework_id) REFERENCES public.competency_frameworks (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_saved_messages
  ADD CONSTRAINT "fk_chat_saved_messages_message_id_org"
  FOREIGN KEY (org_id, message_id) REFERENCES public.chat_messages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_saved_messages
  ADD CONSTRAINT "chat_saved_messages_message_id_chat_messages_id_fk"
  FOREIGN KEY (message_id) REFERENCES public.chat_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders
  ADD CONSTRAINT "fk_chat_reply_reminders_message_id_org"
  FOREIGN KEY (org_id, message_id) REFERENCES public.chat_messages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders
  ADD CONSTRAINT "chat_reply_reminders_message_id_chat_messages_id_fk"
  FOREIGN KEY (message_id) REFERENCES public.chat_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders
  ADD CONSTRAINT "fk_chat_reply_reminders_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders
  ADD CONSTRAINT "chat_reply_reminders_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages
  ADD CONSTRAINT "fk_chat_pinned_messages_message_id_org"
  FOREIGN KEY (org_id, message_id) REFERENCES public.chat_messages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages
  ADD CONSTRAINT "chat_pinned_messages_message_id_chat_messages_id_fk"
  FOREIGN KEY (message_id) REFERENCES public.chat_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages
  ADD CONSTRAINT "fk_chat_pinned_messages_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages
  ADD CONSTRAINT "chat_pinned_messages_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_messages
  ADD CONSTRAINT "fk_chat_messages_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_messages
  ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_huddles
  ADD CONSTRAINT "fk_chat_huddles_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_huddles
  ADD CONSTRAINT "chat_huddles_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_huddle_participants
  ADD CONSTRAINT "fk_chat_huddle_participants_huddle_id_org"
  FOREIGN KEY (org_id, huddle_id) REFERENCES public.chat_huddles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_huddle_participants
  ADD CONSTRAINT "chat_huddle_participants_huddle_id_chat_huddles_id_fk"
  FOREIGN KEY (huddle_id) REFERENCES public.chat_huddles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_channel_members
  ADD CONSTRAINT "fk_chat_channel_members_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_channel_members
  ADD CONSTRAINT "chat_channel_members_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_channel_invite_links
  ADD CONSTRAINT "fk_chat_channel_invite_links_channel_id_org"
  FOREIGN KEY (org_id, channel_id) REFERENCES public.chat_channels (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_channel_invite_links
  ADD CONSTRAINT "chat_channel_invite_links_channel_id_chat_channels_id_fk"
  FOREIGN KEY (channel_id) REFERENCES public.chat_channels (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_attachments
  ADD CONSTRAINT "fk_chat_attachments_message_id_org"
  FOREIGN KEY (org_id, message_id) REFERENCES public.chat_messages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.chat_attachments
  ADD CONSTRAINT "chat_attachments_message_id_chat_messages_id_fk"
  FOREIGN KEY (message_id) REFERENCES public.chat_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.candidate_resumes
  ADD CONSTRAINT "fk_candidate_resumes_org_candidate"
  FOREIGN KEY (org_id, candidate_id) REFERENCES public.candidates (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.candidate_resumes
  ADD CONSTRAINT "candidate_resumes_candidate_id_fkey"
  FOREIGN KEY (candidate_id) REFERENCES public.candidates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.broadcast_read_receipts
  ADD CONSTRAINT "broadcast_read_receipts_broadcast_id_fkey"
  FOREIGN KEY (broadcast_id) REFERENCES public.broadcasts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.broadcast_audience_targets
  ADD CONSTRAINT "broadcast_audience_targets_broadcast_id_fkey"
  FOREIGN KEY (broadcast_id) REFERENCES public.broadcasts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.biometric_logs
  ADD CONSTRAINT "biometric_logs_device_id_biometric_devices_id_fk"
  FOREIGN KEY (device_id) REFERENCES public.biometric_devices (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_ro"
  FOREIGN KEY (usage_rollup_id) REFERENCES public.billing_usage_rollups (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snap"
  FOREIGN KEY (snapshot_id) REFERENCES public.billing_invoice_snapshots (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots
  ADD CONSTRAINT "billing_invoice_line_snapshots_proration_line_id_billing_prorat"
  FOREIGN KEY (proration_line_id) REFERENCES public.billing_proration_lines (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_credit_notes
  ADD CONSTRAINT "billing_credit_notes_original_snapshot_id_billing_invoice_snaps"
  FOREIGN KEY (original_snapshot_id) REFERENCES public.billing_invoice_snapshots (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.billing_credit_note_lines
  ADD CONSTRAINT "billing_credit_note_lines_credit_note_id_billing_credit_notes_i"
  FOREIGN KEY (credit_note_id) REFERENCES public.billing_credit_notes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statements
  ADD CONSTRAINT "bank_statements_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statements
  ADD CONSTRAINT "bank_statements_bank_profile_id_fkey"
  FOREIGN KEY (bank_profile_id) REFERENCES public.bank_profiles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_statement_lines
  ADD CONSTRAINT "bank_statement_lines_statement_id_fkey"
  FOREIGN KEY (statement_id) REFERENCES public.bank_statements (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_profiles
  ADD CONSTRAINT "bank_profiles_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_profiles
  ADD CONSTRAINT "bank_profiles_account_id_fkey"
  FOREIGN KEY (account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "bank_matches_statement_line_id_fkey"
  FOREIGN KEY (statement_line_id) REFERENCES public.bank_statement_lines (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "bank_matches_receipt_id_fkey"
  FOREIGN KEY (receipt_id) REFERENCES public.ar_receipts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "bank_matches_payment_id_fkey"
  FOREIGN KEY (payment_id) REFERENCES public.ap_payments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "bank_matches_journal_id_fkey"
  FOREIGN KEY (journal_id) REFERENCES public.gl_journals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.bank_matches
  ADD CONSTRAINT "bank_matches_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.automation_runs
  ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk"
  FOREIGN KEY (rule_id) REFERENCES public.automation_rules (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state
  ADD CONSTRAINT "assignment_rule_state_rule_id_lead_assignment_rules_id_fk"
  FOREIGN KEY (rule_id) REFERENCES public.lead_assignment_rules (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.asset_returns
  ADD CONSTRAINT "asset_returns_asset_id_assets_id_fk"
  FOREIGN KEY (asset_id) REFERENCES public.assets (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.assessment_attempts
  ADD CONSTRAINT "assessment_attempts_assessment_id_skill_assessments_id_fk"
  FOREIGN KEY (assessment_id) REFERENCES public.skill_assessments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "ar_receipts_reversal_journal_id_fkey"
  FOREIGN KEY (reversal_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "ar_receipts_posted_journal_id_fkey"
  FOREIGN KEY (posted_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "ar_receipts_party_id_fkey"
  FOREIGN KEY (party_id) REFERENCES public.gl_parties (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "ar_receipts_deposit_account_id_fkey"
  FOREIGN KEY (deposit_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_receipts
  ADD CONSTRAINT "ar_receipts_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "ar_documents_posted_journal_id_fkey"
  FOREIGN KEY (posted_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "ar_documents_party_id_fkey"
  FOREIGN KEY (party_id) REFERENCES public.gl_parties (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "ar_documents_original_document_id_fkey"
  FOREIGN KEY (original_document_id) REFERENCES public.ar_documents (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_documents
  ADD CONSTRAINT "ar_documents_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_document_lines
  ADD CONSTRAINT "ar_document_lines_income_account_id_fkey"
  FOREIGN KEY (income_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_document_lines
  ADD CONSTRAINT "ar_document_lines_document_id_fkey"
  FOREIGN KEY (document_id) REFERENCES public.ar_documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "ar_allocations_receipt_id_fkey"
  FOREIGN KEY (receipt_id) REFERENCES public.ar_receipts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "ar_allocations_document_id_fkey"
  FOREIGN KEY (document_id) REFERENCES public.ar_documents (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "ar_allocations_credit_note_id_fkey"
  FOREIGN KEY (credit_note_id) REFERENCES public.ar_documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ar_allocations
  ADD CONSTRAINT "ar_allocations_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "ap_withholding_payment_id_fkey"
  FOREIGN KEY (payment_id) REFERENCES public.ap_payments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "ap_withholding_gl_account_id_fkey"
  FOREIGN KEY (gl_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "ap_withholding_document_id_fkey"
  FOREIGN KEY (document_id) REFERENCES public.ap_documents (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_withholding
  ADD CONSTRAINT "ap_withholding_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "ap_payments_reversal_journal_id_fkey"
  FOREIGN KEY (reversal_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "ap_payments_posted_journal_id_fkey"
  FOREIGN KEY (posted_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "ap_payments_payment_account_id_fkey"
  FOREIGN KEY (payment_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "ap_payments_party_id_fkey"
  FOREIGN KEY (party_id) REFERENCES public.gl_parties (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_payments
  ADD CONSTRAINT "ap_payments_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "ap_documents_posted_journal_id_fkey"
  FOREIGN KEY (posted_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "ap_documents_party_id_fkey"
  FOREIGN KEY (party_id) REFERENCES public.gl_parties (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "ap_documents_original_document_id_fkey"
  FOREIGN KEY (original_document_id) REFERENCES public.ap_documents (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_documents
  ADD CONSTRAINT "ap_documents_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_document_lines
  ADD CONSTRAINT "ap_document_lines_expense_account_id_fkey"
  FOREIGN KEY (expense_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_document_lines
  ADD CONSTRAINT "ap_document_lines_document_id_fkey"
  FOREIGN KEY (document_id) REFERENCES public.ap_documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "ap_allocations_payment_id_fkey"
  FOREIGN KEY (payment_id) REFERENCES public.ap_payments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "ap_allocations_document_id_fkey"
  FOREIGN KEY (document_id) REFERENCES public.ap_documents (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "ap_allocations_debit_note_id_fkey"
  FOREIGN KEY (debit_note_id) REFERENCES public.ap_documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ap_allocations
  ADD CONSTRAINT "ap_allocations_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.announcement_targets
  ADD CONSTRAINT "announcement_targets_announcement_id_announcements_id_fk"
  FOREIGN KEY (announcement_id) REFERENCES public.announcements (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.announcement_reads
  ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk"
  FOREIGN KEY (announcement_id) REFERENCES public.announcements (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages
  ADD CONSTRAINT "ai_chat_messages_conversation_id_ai_chat_conversations_id_fk"
  FOREIGN KEY (conversation_id) REFERENCES public.ai_chat_conversations (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.accounting_settings
  ADD CONSTRAINT "accounting_settings_retained_earnings_account_id_ledger_account"
  FOREIGN KEY (retained_earnings_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values
  ADD CONSTRAINT "accounting_dimension_values_dimension_id_accounting_dimensions_"
  FOREIGN KEY (dimension_id) REFERENCES public.accounting_dimensions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_tax_payments
  ADD CONSTRAINT "acc_tax_payments_journal_entry_id_journal_entries_id_fk"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes
  ADD CONSTRAINT "acc_tax_codes_paid_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (paid_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes
  ADD CONSTRAINT "acc_tax_codes_collected_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (collected_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map
  ADD CONSTRAINT "acc_system_account_map_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (account_id) REFERENCES public.ledger_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets
  ADD CONSTRAINT "acc_fixed_assets_disposal_journal_entry_id_journal_entries_id_f"
  FOREIGN KEY (disposal_journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets
  ADD CONSTRAINT "acc_fixed_assets_category_id_acc_asset_categories_id_fk"
  FOREIGN KEY (category_id) REFERENCES public.acc_asset_categories (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets
  ADD CONSTRAINT "acc_fixed_assets_bill_id_purchase_bills_id_fk"
  FOREIGN KEY (bill_id) REFERENCES public.purchase_bills (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules
  ADD CONSTRAINT "acc_depreciation_schedules_run_id_acc_depreciation_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.acc_depreciation_runs (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules
  ADD CONSTRAINT "acc_depreciation_schedules_journal_entry_id_journal_entries_id_"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules
  ADD CONSTRAINT "acc_depreciation_schedules_asset_id_acc_fixed_assets_id_fk"
  FOREIGN KEY (asset_id) REFERENCES public.acc_fixed_assets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_runs
  ADD CONSTRAINT "acc_depreciation_runs_journal_entry_id_journal_entries_id_fk"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories
  ADD CONSTRAINT "acc_asset_categories_depreciation_expense_account_id_ledger_acc"
  FOREIGN KEY (depreciation_expense_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories
  ADD CONSTRAINT "acc_asset_categories_asset_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (asset_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories
  ADD CONSTRAINT "acc_asset_categories_accumulated_depreciation_account_id_ledger"
  FOREIGN KEY (accumulated_depreciation_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;

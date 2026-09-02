-- AR-02: drop the single-column and duplicate composite tenant foreign keys superseded by the canonical composites, part 1 of 4.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories DROP CONSTRAINT "acc_asset_categories_accumulated_depreciation_account_id_ledger";
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories DROP CONSTRAINT "acc_asset_categories_asset_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_asset_categories DROP CONSTRAINT "acc_asset_categories_depreciation_expense_account_id_ledger_acc";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_runs DROP CONSTRAINT "acc_depreciation_runs_journal_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules DROP CONSTRAINT "acc_depreciation_schedules_asset_id_acc_fixed_assets_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules DROP CONSTRAINT "acc_depreciation_schedules_journal_entry_id_journal_entries_id_";
--> statement-breakpoint
ALTER TABLE public.acc_depreciation_schedules DROP CONSTRAINT "acc_depreciation_schedules_run_id_acc_depreciation_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets DROP CONSTRAINT "acc_fixed_assets_bill_id_purchase_bills_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets DROP CONSTRAINT "acc_fixed_assets_category_id_acc_asset_categories_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_fixed_assets DROP CONSTRAINT "acc_fixed_assets_disposal_journal_entry_id_journal_entries_id_f";
--> statement-breakpoint
ALTER TABLE public.acc_system_account_map DROP CONSTRAINT "acc_system_account_map_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes DROP CONSTRAINT "acc_tax_codes_collected_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_tax_codes DROP CONSTRAINT "acc_tax_codes_paid_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.acc_tax_payments DROP CONSTRAINT "acc_tax_payments_journal_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE public.accounting_dimension_values DROP CONSTRAINT "accounting_dimension_values_dimension_id_accounting_dimensions_";
--> statement-breakpoint
ALTER TABLE public.accounting_settings DROP CONSTRAINT "accounting_settings_retained_earnings_account_id_ledger_account";
--> statement-breakpoint
ALTER TABLE public.ai_chat_messages DROP CONSTRAINT "ai_chat_messages_conversation_id_ai_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE public.announcement_reads DROP CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk";
--> statement-breakpoint
ALTER TABLE public.announcement_targets DROP CONSTRAINT "announcement_targets_announcement_id_announcements_id_fk";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT "ap_allocations_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT "ap_allocations_debit_note_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT "ap_allocations_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_allocations DROP CONSTRAINT "ap_allocations_payment_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines DROP CONSTRAINT "ap_document_lines_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_document_lines DROP CONSTRAINT "ap_document_lines_expense_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT "ap_documents_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT "ap_documents_original_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT "ap_documents_party_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_documents DROP CONSTRAINT "ap_documents_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT "ap_payments_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT "ap_payments_party_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT "ap_payments_payment_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT "ap_payments_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_payments DROP CONSTRAINT "ap_payments_reversal_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT "ap_withholding_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT "ap_withholding_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT "ap_withholding_gl_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ap_withholding DROP CONSTRAINT "ap_withholding_payment_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT "ar_allocations_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT "ar_allocations_credit_note_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT "ar_allocations_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_allocations DROP CONSTRAINT "ar_allocations_receipt_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines DROP CONSTRAINT "ar_document_lines_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_document_lines DROP CONSTRAINT "ar_document_lines_income_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT "ar_documents_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT "ar_documents_original_document_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT "ar_documents_party_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_documents DROP CONSTRAINT "ar_documents_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT "ar_receipts_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT "ar_receipts_deposit_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT "ar_receipts_party_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT "ar_receipts_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.ar_receipts DROP CONSTRAINT "ar_receipts_reversal_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.assessment_attempts DROP CONSTRAINT "assessment_attempts_assessment_id_skill_assessments_id_fk";
--> statement-breakpoint
ALTER TABLE public.asset_returns DROP CONSTRAINT "asset_returns_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE public.assignment_rule_state DROP CONSTRAINT "assignment_rule_state_rule_id_lead_assignment_rules_id_fk";
--> statement-breakpoint
ALTER TABLE public.automation_runs DROP CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT "bank_matches_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT "bank_matches_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT "bank_matches_payment_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT "bank_matches_receipt_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_matches DROP CONSTRAINT "bank_matches_statement_line_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_profiles DROP CONSTRAINT "bank_profiles_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_profiles DROP CONSTRAINT "bank_profiles_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_statement_lines DROP CONSTRAINT "bank_statement_lines_statement_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_statements DROP CONSTRAINT "bank_statements_bank_profile_id_fkey";
--> statement-breakpoint
ALTER TABLE public.bank_statements DROP CONSTRAINT "bank_statements_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.billing_credit_note_lines DROP CONSTRAINT "billing_credit_note_lines_credit_note_id_billing_credit_notes_i";
--> statement-breakpoint
ALTER TABLE public.billing_credit_notes DROP CONSTRAINT "billing_credit_notes_original_snapshot_id_billing_invoice_snaps";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT "billing_invoice_line_snapshots_proration_line_id_billing_prorat";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snap";
--> statement-breakpoint
ALTER TABLE public.billing_invoice_line_snapshots DROP CONSTRAINT "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_ro";
--> statement-breakpoint
ALTER TABLE public.biometric_logs DROP CONSTRAINT "biometric_logs_device_id_biometric_devices_id_fk";
--> statement-breakpoint
ALTER TABLE public.broadcast_audience_targets DROP CONSTRAINT "broadcast_audience_targets_broadcast_id_fkey";
--> statement-breakpoint
ALTER TABLE public.broadcast_read_receipts DROP CONSTRAINT "broadcast_read_receipts_broadcast_id_fkey";
--> statement-breakpoint
ALTER TABLE public.candidate_resumes DROP CONSTRAINT "candidate_resumes_candidate_id_fkey";
--> statement-breakpoint
ALTER TABLE public.candidate_resumes DROP CONSTRAINT "fk_candidate_resumes_org_candidate";
--> statement-breakpoint
ALTER TABLE public.chat_attachments DROP CONSTRAINT "chat_attachments_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_attachments DROP CONSTRAINT "fk_chat_attachments_message_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_channel_invite_links DROP CONSTRAINT "chat_channel_invite_links_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_channel_invite_links DROP CONSTRAINT "fk_chat_channel_invite_links_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_channel_members DROP CONSTRAINT "chat_channel_members_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_channel_members DROP CONSTRAINT "fk_chat_channel_members_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_huddle_participants DROP CONSTRAINT "chat_huddle_participants_huddle_id_chat_huddles_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_huddle_participants DROP CONSTRAINT "fk_chat_huddle_participants_huddle_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_huddles DROP CONSTRAINT "chat_huddles_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_huddles DROP CONSTRAINT "fk_chat_huddles_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_messages DROP CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_messages DROP CONSTRAINT "fk_chat_messages_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages DROP CONSTRAINT "chat_pinned_messages_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages DROP CONSTRAINT "fk_chat_pinned_messages_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages DROP CONSTRAINT "chat_pinned_messages_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_pinned_messages DROP CONSTRAINT "fk_chat_pinned_messages_message_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders DROP CONSTRAINT "chat_reply_reminders_channel_id_chat_channels_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders DROP CONSTRAINT "fk_chat_reply_reminders_channel_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders DROP CONSTRAINT "chat_reply_reminders_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_reply_reminders DROP CONSTRAINT "fk_chat_reply_reminders_message_id_org";
--> statement-breakpoint
ALTER TABLE public.chat_saved_messages DROP CONSTRAINT "chat_saved_messages_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE public.chat_saved_messages DROP CONSTRAINT "fk_chat_saved_messages_message_id_org";
--> statement-breakpoint
ALTER TABLE public.competencies DROP CONSTRAINT "competencies_framework_id_competency_frameworks_id_fk";
--> statement-breakpoint
ALTER TABLE public.coupon_redemptions DROP CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk";
--> statement-breakpoint
ALTER TABLE public.document_audit_logs DROP CONSTRAINT "document_audit_logs_onboarding_document_id_onboarding_documents";
--> statement-breakpoint
ALTER TABLE public.document_template_versions DROP CONSTRAINT "document_template_versions_template_id_document_templates_id_fk";
--> statement-breakpoint
ALTER TABLE public.documents DROP CONSTRAINT "fk_documents_department";
--> statement-breakpoint
ALTER TABLE public.dunning_attempts DROP CONSTRAINT "dunning_attempts_subscription_id_subscriptions_id_fk";
--> statement-breakpoint
ALTER TABLE public.email_sequence_steps DROP CONSTRAINT "email_sequence_steps_sequence_id_email_sequences_id_fk";
--> statement-breakpoint
ALTER TABLE public.exit_checklists DROP CONSTRAINT "exit_checklists_resignation_id_resignations_id_fk";
--> statement-breakpoint
ALTER TABLE public.exit_checklists DROP CONSTRAINT "fk_exit_checklists_resignation_id_org";
--> statement-breakpoint
ALTER TABLE public.expense_categories DROP CONSTRAINT "expense_categories_ledger_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.expenses DROP CONSTRAINT "expenses_posted_journal_entry_id_journal_entries_id_fk";

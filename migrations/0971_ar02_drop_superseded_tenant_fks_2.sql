-- AR-02: drop the single-column and duplicate composite tenant foreign keys superseded by the canonical composites, part 2 of 4.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests DROP CONSTRAINT "feedback_cycle_requests_cycle_id_feedback_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses DROP CONSTRAINT "feedback_cycle_responses_request_id_feedback_cycle_requests_id_";
--> statement-breakpoint
ALTER TABLE public.feedback_requests DROP CONSTRAINT "feedback_requests_cycle_id_review_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_accounts DROP CONSTRAINT "fin_bank_accounts_ledger_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports DROP CONSTRAINT "fin_bank_imports_bank_account_id_fin_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT "fin_bank_transactions_bank_account_id_fin_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT "fin_bank_transactions_import_id_fin_bank_imports_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions DROP CONSTRAINT "fin_bank_transactions_matched_journal_entry_id_journal_entries_";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers DROP CONSTRAINT "fin_bank_transfers_from_bank_account_id_fin_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers DROP CONSTRAINT "fin_bank_transfers_journal_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers DROP CONSTRAINT "fin_bank_transfers_to_bank_account_id_fin_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT "fin_budget_lines_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT "fin_budget_lines_budget_id_fin_budgets_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT "fk_fin_budget_lines_department";
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines DROP CONSTRAINT "fin_budget_lines_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions DROP CONSTRAINT "fin_budget_revisions_budget_id_fin_budgets_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities DROP CONSTRAINT "fin_collection_activities_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies DROP CONSTRAINT "fin_expense_policies_category_id_fkey";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT "fin_payment_allocations_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations DROP CONSTRAINT "fin_payment_allocations_payment_id_payments_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items DROP CONSTRAINT "fin_payment_run_items_bill_id_purchase_bills_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items DROP CONSTRAINT "fin_payment_run_items_run_id_fin_payment_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items DROP CONSTRAINT "fin_payment_run_items_vendor_payment_id_vendor_payments_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches DROP CONSTRAINT "fin_reconciliation_matches_bank_transaction_id_fin_bank_transac";
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches DROP CONSTRAINT "fin_reconciliation_matches_journal_entry_id_journal_entries_id_";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_bank_account_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_journal_entry_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_journal_entry_id_journal_entries_id_f";
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches DROP CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log DROP CONSTRAINT "fin_reminder_log_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT "fin_vendor_payment_allocations_bill_id_purchase_bills_id_fk";
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations DROP CONSTRAINT "fin_vendor_payment_allocations_vendor_payment_id_vendor_payment";
--> statement-breakpoint
ALTER TABLE public.fnf_settlements DROP CONSTRAINT "fnf_settlements_resignation_id_resignations_id_fk";
--> statement-breakpoint
ALTER TABLE public.gl_accounts DROP CONSTRAINT "gl_accounts_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_accounts DROP CONSTRAINT "gl_accounts_parent_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_book_currencies DROP CONSTRAINT "gl_book_currencies_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_books DROP CONSTRAINT "gl_books_legal_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_books DROP CONSTRAINT "gl_books_parent_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_document_attachments DROP CONSTRAINT "gl_document_attachments_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_document_compliance DROP CONSTRAINT "gl_document_compliance_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences DROP CONSTRAINT "gl_document_sequences_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences DROP CONSTRAINT "gl_document_sequences_fiscal_year_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_fiscal_years DROP CONSTRAINT "gl_fiscal_years_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_fx_rates DROP CONSTRAINT "gl_fx_rates_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_dimension_branch_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_dimension_project_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_fx_rate_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT "gl_journal_lines_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT "gl_journals_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT "gl_journals_period_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT "gl_journals_reversed_by_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT "gl_journals_reverses_journal_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT "gl_parties_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT "gl_parties_default_expense_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT "gl_parties_default_income_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_periods DROP CONSTRAINT "gl_periods_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.gl_periods DROP CONSTRAINT "gl_periods_fiscal_year_id_fkey";
--> statement-breakpoint
ALTER TABLE public.group_role_assignments DROP CONSTRAINT "group_role_assignments_principal_group_id_fkey";
--> statement-breakpoint
ALTER TABLE public.group_role_assignments DROP CONSTRAINT "group_role_assignments_role_id_fkey";
--> statement-breakpoint
ALTER TABLE public.handbook_versions DROP CONSTRAINT "handbook_versions_document_id_rich_documents_id_fk";
--> statement-breakpoint
ALTER TABLE public.hr_comp_budget_pools DROP CONSTRAINT "fk_hr_comp_budget_pools_department";
--> statement-breakpoint
ALTER TABLE public.hr_employment_custom_field_values DROP CONSTRAINT "hr_employment_custom_field_values_employment_id_fkey";
--> statement-breakpoint
ALTER TABLE public.hr_employment_custom_field_values DROP CONSTRAINT "hr_employment_custom_field_values_field_definition_id_fkey";
--> statement-breakpoint
ALTER TABLE public.hr_employments DROP CONSTRAINT "fk_hr_employments_department";
--> statement-breakpoint
ALTER TABLE public.hr_employments DROP CONSTRAINT "fk_hr_employments_job_level";
--> statement-breakpoint
ALTER TABLE public.hr_employments DROP CONSTRAINT "fk_hr_employments_job_role";
--> statement-breakpoint
ALTER TABLE public.hr_employments DROP CONSTRAINT "fk_hr_employments_location";
--> statement-breakpoint
ALTER TABLE public.hr_headcount_plans DROP CONSTRAINT "fk_hr_headcount_plans_department";
--> statement-breakpoint
ALTER TABLE public.incentive_config DROP CONSTRAINT "fk_incentive_config_branch_id";
--> statement-breakpoint
ALTER TABLE public.incentives DROP CONSTRAINT "fk_incentives_branch_id";
--> statement-breakpoint
ALTER TABLE public.invitation_events DROP CONSTRAINT "invitation_events_invitation_id_invitations_id_fk";
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT "fk_invitations_accepted_membership";
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT "fk_invitations_inviter_membership";
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT "invitations_revoked_by_membership_id_organization_members_id_fk";
--> statement-breakpoint
ALTER TABLE public.invoice_items DROP CONSTRAINT "invoice_items_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE public.invoices DROP CONSTRAINT "invoices_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE public.journal_lines DROP CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE public.journal_lines DROP CONSTRAINT "fk_journal_lines_department";
--> statement-breakpoint
ALTER TABLE public.journal_lines DROP CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_attachments DROP CONSTRAINT "kb_article_attachments_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_attachments DROP CONSTRAINT "fk_kb_article_attachments_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "kb_article_chunks_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "fk_kb_article_chunks_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "kb_article_chunks_attachment_id_kb_article_attachments_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "fk_kb_article_chunks_attachment_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "kb_article_chunks_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "fk_kb_article_chunks_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "kb_article_chunks_source_id_kb_sources_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks DROP CONSTRAINT "fk_kb_article_chunks_source_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_comments DROP CONSTRAINT "kb_article_comments_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_feedback DROP CONSTRAINT "kb_article_feedback_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_feedback DROP CONSTRAINT "fk_kb_article_feedback_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_restrictions DROP CONSTRAINT "kb_article_restrictions_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_restrictions DROP CONSTRAINT "fk_kb_article_restrictions_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_tags DROP CONSTRAINT "kb_article_tags_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_tags DROP CONSTRAINT "fk_kb_article_tags_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_tags DROP CONSTRAINT "kb_article_tags_tag_id_kb_tags_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_tags DROP CONSTRAINT "fk_kb_article_tags_tag_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_translations DROP CONSTRAINT "kb_article_translations_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_translations DROP CONSTRAINT "fk_kb_article_translations_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_versions DROP CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_article_versions DROP CONSTRAINT "fk_kb_article_versions_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_articles DROP CONSTRAINT "kb_articles_category_id_kb_categories_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_articles DROP CONSTRAINT "fk_kb_articles_category_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_articles DROP CONSTRAINT "kb_articles_space_id_kb_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_articles DROP CONSTRAINT "fk_kb_articles_space_id_org";

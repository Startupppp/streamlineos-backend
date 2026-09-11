-- 0971_ar02_drop_superseded_tenant_fks_2 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.kb_articles
  ADD CONSTRAINT "fk_kb_articles_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_articles
  ADD CONSTRAINT "kb_articles_space_id_kb_spaces_id_fk"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_articles
  ADD CONSTRAINT "fk_kb_articles_category_id_org"
  FOREIGN KEY (org_id, category_id) REFERENCES public.kb_categories (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_articles
  ADD CONSTRAINT "kb_articles_category_id_kb_categories_id_fk"
  FOREIGN KEY (category_id) REFERENCES public.kb_categories (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_versions
  ADD CONSTRAINT "fk_kb_article_versions_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_versions
  ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_translations
  ADD CONSTRAINT "fk_kb_article_translations_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_translations
  ADD CONSTRAINT "kb_article_translations_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_tags
  ADD CONSTRAINT "fk_kb_article_tags_tag_id_org"
  FOREIGN KEY (org_id, tag_id) REFERENCES public.kb_tags (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_tags
  ADD CONSTRAINT "kb_article_tags_tag_id_kb_tags_id_fk"
  FOREIGN KEY (tag_id) REFERENCES public.kb_tags (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_tags
  ADD CONSTRAINT "fk_kb_article_tags_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_tags
  ADD CONSTRAINT "kb_article_tags_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_restrictions
  ADD CONSTRAINT "fk_kb_article_restrictions_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_restrictions
  ADD CONSTRAINT "kb_article_restrictions_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_feedback
  ADD CONSTRAINT "fk_kb_article_feedback_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_feedback
  ADD CONSTRAINT "kb_article_feedback_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_comments
  ADD CONSTRAINT "kb_article_comments_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "fk_kb_article_chunks_source_id_org"
  FOREIGN KEY (org_id, source_id) REFERENCES public.kb_sources (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "kb_article_chunks_source_id_kb_sources_id_fk"
  FOREIGN KEY (source_id) REFERENCES public.kb_sources (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "fk_kb_article_chunks_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "kb_article_chunks_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "fk_kb_article_chunks_attachment_id_org"
  FOREIGN KEY (org_id, attachment_id) REFERENCES public.kb_article_attachments (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "kb_article_chunks_attachment_id_kb_article_attachments_id_fk"
  FOREIGN KEY (attachment_id) REFERENCES public.kb_article_attachments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "fk_kb_article_chunks_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_chunks
  ADD CONSTRAINT "kb_article_chunks_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_attachments
  ADD CONSTRAINT "fk_kb_article_attachments_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_attachments
  ADD CONSTRAINT "kb_article_attachments_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines
  ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk"
  FOREIGN KEY (entry_id) REFERENCES public.journal_entries (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines
  ADD CONSTRAINT "fk_journal_lines_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines
  ADD CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (account_id) REFERENCES public.ledger_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invoices
  ADD CONSTRAINT "invoices_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invoice_items
  ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk"
  FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "invitations_revoked_by_membership_id_organization_members_id_fk"
  FOREIGN KEY (revoked_by_membership_id) REFERENCES public.organization_members (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "fk_invitations_inviter_membership"
  FOREIGN KEY (inviter_membership_id) REFERENCES public.organization_members (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "fk_invitations_accepted_membership"
  FOREIGN KEY (accepted_membership_id) REFERENCES public.organization_members (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitation_events
  ADD CONSTRAINT "invitation_events_invitation_id_invitations_id_fk"
  FOREIGN KEY (invitation_id) REFERENCES public.invitations (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.incentives
  ADD CONSTRAINT "fk_incentives_branch_id"
  FOREIGN KEY (branch_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.incentive_config
  ADD CONSTRAINT "fk_incentive_config_branch_id"
  FOREIGN KEY (branch_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_headcount_plans
  ADD CONSTRAINT "fk_hr_headcount_plans_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employments
  ADD CONSTRAINT "fk_hr_employments_location"
  FOREIGN KEY (location_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employments
  ADD CONSTRAINT "fk_hr_employments_job_role"
  FOREIGN KEY (job_role_id) REFERENCES public.hr_job_roles (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employments
  ADD CONSTRAINT "fk_hr_employments_job_level"
  FOREIGN KEY (job_level_id) REFERENCES public.hr_job_levels (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employments
  ADD CONSTRAINT "fk_hr_employments_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employment_custom_field_values
  ADD CONSTRAINT "hr_employment_custom_field_values_field_definition_id_fkey"
  FOREIGN KEY (field_definition_id) REFERENCES public.custom_field_definitions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_employment_custom_field_values
  ADD CONSTRAINT "hr_employment_custom_field_values_employment_id_fkey"
  FOREIGN KEY (employment_id) REFERENCES public.hr_employments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.hr_comp_budget_pools
  ADD CONSTRAINT "fk_hr_comp_budget_pools_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.handbook_versions
  ADD CONSTRAINT "handbook_versions_document_id_rich_documents_id_fk"
  FOREIGN KEY (document_id) REFERENCES public.rich_documents (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.group_role_assignments
  ADD CONSTRAINT "group_role_assignments_role_id_fkey"
  FOREIGN KEY (role_id) REFERENCES public.roles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.group_role_assignments
  ADD CONSTRAINT "group_role_assignments_principal_group_id_fkey"
  FOREIGN KEY (principal_group_id) REFERENCES public.principal_groups (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_periods
  ADD CONSTRAINT "gl_periods_fiscal_year_id_fkey"
  FOREIGN KEY (fiscal_year_id) REFERENCES public.gl_fiscal_years (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_periods
  ADD CONSTRAINT "gl_periods_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "gl_parties_default_income_account_id_fkey"
  FOREIGN KEY (default_income_account_id) REFERENCES public.gl_accounts (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "gl_parties_default_expense_account_id_fkey"
  FOREIGN KEY (default_expense_account_id) REFERENCES public.gl_accounts (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "gl_parties_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "gl_journals_reverses_journal_id_fkey"
  FOREIGN KEY (reverses_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "gl_journals_reversed_by_journal_id_fkey"
  FOREIGN KEY (reversed_by_journal_id) REFERENCES public.gl_journals (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "gl_journals_period_id_fkey"
  FOREIGN KEY (period_id) REFERENCES public.gl_periods (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "gl_journals_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_journal_id_fkey"
  FOREIGN KEY (journal_id) REFERENCES public.gl_journals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_fx_rate_id_fkey"
  FOREIGN KEY (fx_rate_id) REFERENCES public.gl_fx_rates (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_dimension_project_id_fkey"
  FOREIGN KEY (dimension_project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_dimension_branch_id_fkey"
  FOREIGN KEY (dimension_branch_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "gl_journal_lines_account_id_fkey"
  FOREIGN KEY (account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_fx_rates
  ADD CONSTRAINT "gl_fx_rates_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_fiscal_years
  ADD CONSTRAINT "gl_fiscal_years_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences
  ADD CONSTRAINT "gl_document_sequences_fiscal_year_id_fkey"
  FOREIGN KEY (fiscal_year_id) REFERENCES public.gl_fiscal_years (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences
  ADD CONSTRAINT "gl_document_sequences_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_compliance
  ADD CONSTRAINT "gl_document_compliance_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_attachments
  ADD CONSTRAINT "gl_document_attachments_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_books
  ADD CONSTRAINT "gl_books_parent_book_id_fkey"
  FOREIGN KEY (parent_book_id) REFERENCES public.gl_books (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_books
  ADD CONSTRAINT "gl_books_legal_entity_id_fkey"
  FOREIGN KEY (legal_entity_id) REFERENCES public.legal_entities (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_book_currencies
  ADD CONSTRAINT "gl_book_currencies_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_accounts
  ADD CONSTRAINT "gl_accounts_parent_account_id_fkey"
  FOREIGN KEY (parent_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_accounts
  ADD CONSTRAINT "gl_accounts_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fnf_settlements
  ADD CONSTRAINT "fnf_settlements_resignation_id_resignations_id_fk"
  FOREIGN KEY (resignation_id) REFERENCES public.resignations (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fin_vendor_payment_allocations_vendor_payment_id_vendor_payment"
  FOREIGN KEY (vendor_payment_id) REFERENCES public.vendor_payments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_vendor_payment_allocations
  ADD CONSTRAINT "fin_vendor_payment_allocations_bill_id_purchase_bills_id_fk"
  FOREIGN KEY (bill_id) REFERENCES public.purchase_bills (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reminder_log
  ADD CONSTRAINT "fin_reminder_log_invoice_id_invoices_id_fk"
  FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_posted_journal_id_fkey"
  FOREIGN KEY (posted_journal_id) REFERENCES public.gl_journals (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_journal_entries_id_f"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_fk"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_cash_account_id_fkey"
  FOREIGN KEY (cash_account_id) REFERENCES public.gl_accounts (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fk"
  FOREIGN KEY (bank_account_id) REFERENCES public.fin_bank_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reimbursement_batches
  ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_"
  FOREIGN KEY (bank_account_id) REFERENCES public.fin_bank_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches
  ADD CONSTRAINT "fin_reconciliation_matches_journal_entry_id_journal_entries_id_"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_reconciliation_matches
  ADD CONSTRAINT "fin_reconciliation_matches_bank_transaction_id_fin_bank_transac"
  FOREIGN KEY (bank_transaction_id) REFERENCES public.fin_bank_transactions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items
  ADD CONSTRAINT "fin_payment_run_items_vendor_payment_id_vendor_payments_id_fk"
  FOREIGN KEY (vendor_payment_id) REFERENCES public.vendor_payments (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items
  ADD CONSTRAINT "fin_payment_run_items_run_id_fin_payment_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.fin_payment_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_run_items
  ADD CONSTRAINT "fin_payment_run_items_bill_id_purchase_bills_id_fk"
  FOREIGN KEY (bill_id) REFERENCES public.purchase_bills (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fin_payment_allocations_payment_id_payments_id_fk"
  FOREIGN KEY (payment_id) REFERENCES public.payments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_payment_allocations
  ADD CONSTRAINT "fin_payment_allocations_invoice_id_invoices_id_fk"
  FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_expense_policies
  ADD CONSTRAINT "fin_expense_policies_category_id_fkey"
  FOREIGN KEY (category_id) REFERENCES public.expense_categories (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_collection_activities
  ADD CONSTRAINT "fin_collection_activities_invoice_id_invoices_id_fk"
  FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_revisions
  ADD CONSTRAINT "fin_budget_revisions_budget_id_fin_budgets_id_fk"
  FOREIGN KEY (budget_id) REFERENCES public.fin_budgets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fin_budget_lines_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fk_fin_budget_lines_department"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fin_budget_lines_budget_id_fin_budgets_id_fk"
  FOREIGN KEY (budget_id) REFERENCES public.fin_budgets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_budget_lines
  ADD CONSTRAINT "fin_budget_lines_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers
  ADD CONSTRAINT "fin_bank_transfers_to_bank_account_id_fin_bank_accounts_id_fk"
  FOREIGN KEY (to_bank_account_id) REFERENCES public.fin_bank_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers
  ADD CONSTRAINT "fin_bank_transfers_journal_entry_id_journal_entries_id_fk"
  FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transfers
  ADD CONSTRAINT "fin_bank_transfers_from_bank_account_id_fin_bank_accounts_id_fk"
  FOREIGN KEY (from_bank_account_id) REFERENCES public.fin_bank_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fin_bank_transactions_matched_journal_entry_id_journal_entries_"
  FOREIGN KEY (matched_journal_entry_id) REFERENCES public.journal_entries (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fin_bank_transactions_import_id_fin_bank_imports_id_fk"
  FOREIGN KEY (import_id) REFERENCES public.fin_bank_imports (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_transactions
  ADD CONSTRAINT "fin_bank_transactions_bank_account_id_fin_bank_accounts_id_fk"
  FOREIGN KEY (bank_account_id) REFERENCES public.fin_bank_accounts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_imports
  ADD CONSTRAINT "fin_bank_imports_bank_account_id_fin_bank_accounts_id_fk"
  FOREIGN KEY (bank_account_id) REFERENCES public.fin_bank_accounts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.fin_bank_accounts
  ADD CONSTRAINT "fin_bank_accounts_ledger_account_id_ledger_accounts_id_fk"
  FOREIGN KEY (ledger_account_id) REFERENCES public.ledger_accounts (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_requests
  ADD CONSTRAINT "feedback_requests_cycle_id_review_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES public.review_cycles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_responses
  ADD CONSTRAINT "feedback_cycle_responses_request_id_feedback_cycle_requests_id_"
  FOREIGN KEY (request_id) REFERENCES public.feedback_cycle_requests (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.feedback_cycle_requests
  ADD CONSTRAINT "feedback_cycle_requests_cycle_id_feedback_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES public.feedback_cycles (id) ON DELETE CASCADE
  NOT VALID;

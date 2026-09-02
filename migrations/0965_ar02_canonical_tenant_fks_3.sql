-- AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part 3 of 7; the referential action of the single-column constraint being superseded is preserved.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.gl_accounts VALIDATE CONSTRAINT "fk_gl_accounts_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_accounts
  ADD CONSTRAINT "fk_gl_accounts_parent_account_id_org"
  FOREIGN KEY (org_id, parent_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_accounts VALIDATE CONSTRAINT "fk_gl_accounts_parent_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_book_currencies
  ADD CONSTRAINT "fk_gl_book_currencies_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_book_currencies VALIDATE CONSTRAINT "fk_gl_book_currencies_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_books
  ADD CONSTRAINT "fk_gl_books_legal_entity_id_org"
  FOREIGN KEY (org_id, legal_entity_id)
  REFERENCES public.legal_entities (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_books VALIDATE CONSTRAINT "fk_gl_books_legal_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_books
  ADD CONSTRAINT "fk_gl_books_parent_book_id_org"
  FOREIGN KEY (org_id, parent_book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE SET NULL (parent_book_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_books VALIDATE CONSTRAINT "fk_gl_books_parent_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_attachments
  ADD CONSTRAINT "fk_gl_document_attachments_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_attachments VALIDATE CONSTRAINT "fk_gl_document_attachments_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_compliance
  ADD CONSTRAINT "fk_gl_document_compliance_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_compliance VALIDATE CONSTRAINT "fk_gl_document_compliance_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences
  ADD CONSTRAINT "fk_gl_document_sequences_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences VALIDATE CONSTRAINT "fk_gl_document_sequences_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences
  ADD CONSTRAINT "fk_gl_document_sequences_fiscal_year_id_org"
  FOREIGN KEY (org_id, fiscal_year_id)
  REFERENCES public.gl_fiscal_years (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences VALIDATE CONSTRAINT "fk_gl_document_sequences_fiscal_year_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_fiscal_years
  ADD CONSTRAINT "fk_gl_fiscal_years_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_fiscal_years VALIDATE CONSTRAINT "fk_gl_fiscal_years_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_fx_rates
  ADD CONSTRAINT "fk_gl_fx_rates_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_fx_rates VALIDATE CONSTRAINT "fk_gl_fx_rates_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_account_id_org"
  FOREIGN KEY (org_id, account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_dimension_branch_id_org"
  FOREIGN KEY (org_id, dimension_branch_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (dimension_branch_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_dimension_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_dimension_project_id_org"
  FOREIGN KEY (org_id, dimension_project_id)
  REFERENCES build.projects (org_id, id)
  ON DELETE SET NULL (dimension_project_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_dimension_project_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_fx_rate_id_org"
  FOREIGN KEY (org_id, fx_rate_id)
  REFERENCES public.gl_fx_rates (org_id, id)
  ON DELETE SET NULL (fx_rate_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_fx_rate_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines
  ADD CONSTRAINT "fk_gl_journal_lines_journal_id_org"
  FOREIGN KEY (org_id, journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines VALIDATE CONSTRAINT "fk_gl_journal_lines_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "fk_gl_journals_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals VALIDATE CONSTRAINT "fk_gl_journals_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "fk_gl_journals_period_id_org"
  FOREIGN KEY (org_id, period_id)
  REFERENCES public.gl_periods (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals VALIDATE CONSTRAINT "fk_gl_journals_period_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "fk_gl_journals_reversed_by_journal_id_org"
  FOREIGN KEY (org_id, reversed_by_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals VALIDATE CONSTRAINT "fk_gl_journals_reversed_by_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals
  ADD CONSTRAINT "fk_gl_journals_reverses_journal_id_org"
  FOREIGN KEY (org_id, reverses_journal_id)
  REFERENCES public.gl_journals (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_journals VALIDATE CONSTRAINT "fk_gl_journals_reverses_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "fk_gl_parties_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties VALIDATE CONSTRAINT "fk_gl_parties_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "fk_gl_parties_default_expense_account_id_org"
  FOREIGN KEY (org_id, default_expense_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE SET NULL (default_expense_account_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties VALIDATE CONSTRAINT "fk_gl_parties_default_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties
  ADD CONSTRAINT "fk_gl_parties_default_income_account_id_org"
  FOREIGN KEY (org_id, default_income_account_id)
  REFERENCES public.gl_accounts (org_id, id)
  ON DELETE SET NULL (default_income_account_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_parties VALIDATE CONSTRAINT "fk_gl_parties_default_income_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_periods
  ADD CONSTRAINT "fk_gl_periods_book_id_org"
  FOREIGN KEY (org_id, book_id)
  REFERENCES public.gl_books (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_periods VALIDATE CONSTRAINT "fk_gl_periods_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_periods
  ADD CONSTRAINT "fk_gl_periods_fiscal_year_id_org"
  FOREIGN KEY (org_id, fiscal_year_id)
  REFERENCES public.gl_fiscal_years (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.gl_periods VALIDATE CONSTRAINT "fk_gl_periods_fiscal_year_id_org";
--> statement-breakpoint
ALTER TABLE public.incentive_config
  ADD CONSTRAINT "fk_incentive_config_branch_id_org"
  FOREIGN KEY (org_id, branch_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (branch_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.incentive_config VALIDATE CONSTRAINT "fk_incentive_config_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.incentives
  ADD CONSTRAINT "fk_incentives_branch_id_org"
  FOREIGN KEY (org_id, branch_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (branch_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.incentives VALIDATE CONSTRAINT "fk_incentives_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.invitation_events
  ADD CONSTRAINT "fk_invitation_events_invitation_id_org"
  FOREIGN KEY (org_id, invitation_id)
  REFERENCES public.invitations (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitation_events VALIDATE CONSTRAINT "fk_invitation_events_invitation_id_org";
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "fk_invitations_accepted_membership_id_org"
  FOREIGN KEY (org_id, accepted_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (accepted_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations VALIDATE CONSTRAINT "fk_invitations_accepted_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "fk_invitations_inviter_membership_id_org"
  FOREIGN KEY (org_id, inviter_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (inviter_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations VALIDATE CONSTRAINT "fk_invitations_inviter_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invitations
  ADD CONSTRAINT "fk_invitations_revoked_by_membership_id_org"
  FOREIGN KEY (org_id, revoked_by_membership_id)
  REFERENCES public.organization_members (org_id, id)
  ON DELETE SET NULL (revoked_by_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations VALIDATE CONSTRAINT "fk_invitations_revoked_by_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invoice_items DROP CONSTRAINT "fk_invoice_items_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.invoice_items
  ADD CONSTRAINT "fk_invoice_items_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invoice_items VALIDATE CONSTRAINT "fk_invoice_items_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.journal_lines
  ADD CONSTRAINT "fk_journal_lines_account_id_org"
  FOREIGN KEY (org_id, account_id)
  REFERENCES public.ledger_accounts (org_id, id)
  ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT "fk_journal_lines_account_id_org";
--> statement-breakpoint
ALTER TABLE public.journal_lines
  ADD CONSTRAINT "fk_journal_lines_department_id_org"
  FOREIGN KEY (org_id, department_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT "fk_journal_lines_department_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_comments DROP CONSTRAINT "fk_kb_article_comments_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_comments
  ADD CONSTRAINT "fk_kb_article_comments_article_id_org"
  FOREIGN KEY (org_id, article_id)
  REFERENCES public.kb_articles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_article_comments VALIDATE CONSTRAINT "fk_kb_article_comments_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_space_grants
  ADD CONSTRAINT "fk_kb_space_grants_space_id_org"
  FOREIGN KEY (org_id, space_id)
  REFERENCES public.kb_spaces (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_space_grants VALIDATE CONSTRAINT "fk_kb_space_grants_space_id_org";
--> statement-breakpoint
ALTER TABLE public.key_results DROP CONSTRAINT "fk_key_results_goal_id_org";
--> statement-breakpoint
ALTER TABLE public.key_results
  ADD CONSTRAINT "fk_key_results_goal_id_org"
  FOREIGN KEY (org_id, goal_id)
  REFERENCES public.goals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.key_results VALIDATE CONSTRAINT "fk_key_results_goal_id_org";
--> statement-breakpoint
ALTER TABLE public.legal_entities
  ADD CONSTRAINT "fk_legal_entities_org_unit_id_org"
  FOREIGN KEY (org_id, org_unit_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (org_unit_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.legal_entities VALIDATE CONSTRAINT "fk_legal_entities_org_unit_id_org";
--> statement-breakpoint
ALTER TABLE public.legal_entities
  ADD CONSTRAINT "fk_legal_entities_parent_legal_entity_id_org"
  FOREIGN KEY (org_id, parent_legal_entity_id)
  REFERENCES public.legal_entities (org_id, id)
  ON DELETE SET NULL (parent_legal_entity_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.legal_entities VALIDATE CONSTRAINT "fk_legal_entities_parent_legal_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items DROP CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org";
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items
  ADD CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org"
  FOREIGN KEY (org_id, checklist_id)
  REFERENCES public.module_setup_checklists (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items VALIDATE CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org";
--> statement-breakpoint
ALTER TABLE public.notification_audit_logs
  ADD CONSTRAINT "fk_notification_audit_logs_broadcast_id_org"
  FOREIGN KEY (org_id, broadcast_id)
  REFERENCES public.broadcasts (org_id, id)
  ON DELETE SET NULL (broadcast_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_audit_logs VALIDATE CONSTRAINT "fk_notification_audit_logs_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.notification_queue DROP CONSTRAINT "fk_notification_queue_delivery_id_org";
--> statement-breakpoint
ALTER TABLE public.notification_queue
  ADD CONSTRAINT "fk_notification_queue_delivery_id_org"
  FOREIGN KEY (org_id, delivery_id)
  REFERENCES public.notification_deliveries (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_queue VALIDATE CONSTRAINT "fk_notification_queue_delivery_id_org";
--> statement-breakpoint
ALTER TABLE public.nps_responses DROP CONSTRAINT "fk_nps_responses_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.nps_responses
  ADD CONSTRAINT "fk_nps_responses_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.nps_surveys (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.nps_responses VALIDATE CONSTRAINT "fk_nps_responses_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps DROP CONSTRAINT "fk_onboarding_template_steps_template_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps
  ADD CONSTRAINT "fk_onboarding_template_steps_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.onboarding_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps VALIDATE CONSTRAINT "fk_onboarding_template_steps_template_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_templates
  ADD CONSTRAINT "fk_onboarding_templates_department_id_org"
  FOREIGN KEY (org_id, department_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (department_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_templates VALIDATE CONSTRAINT "fk_onboarding_templates_department_id_org";
--> statement-breakpoint
ALTER TABLE public.operator_access_log
  ADD CONSTRAINT "fk_operator_access_log_grant_id_org"
  FOREIGN KEY (org_id, grant_id)
  REFERENCES public.operator_access_grants (org_id, grant_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.operator_access_log VALIDATE CONSTRAINT "fk_operator_access_log_grant_id_org";
--> statement-breakpoint
ALTER TABLE public.org_unit_members
  ADD CONSTRAINT "fk_org_unit_members_org_unit_id_org"
  FOREIGN KEY (org_id, org_unit_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.org_unit_members VALIDATE CONSTRAINT "fk_org_unit_members_org_unit_id_org";
--> statement-breakpoint
ALTER TABLE public.org_units
  ADD CONSTRAINT "fk_org_units_parent_id_org"
  FOREIGN KEY (org_id, parent_id)
  REFERENCES public.org_units (org_id, id)
  ON DELETE SET NULL (parent_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.org_units VALIDATE CONSTRAINT "fk_org_units_parent_id_org";
--> statement-breakpoint
ALTER TABLE public.payment_audit_events DROP CONSTRAINT "fk_payment_audit_events_provider_id_org";

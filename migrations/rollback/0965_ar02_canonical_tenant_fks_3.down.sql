-- 0965_ar02_canonical_tenant_fks_3 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.payment_audit_events
  ADD CONSTRAINT "fk_payment_audit_events_provider_id_org"
  FOREIGN KEY (org_id, provider_id)
  REFERENCES public.payment_providers (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.org_units DROP CONSTRAINT IF EXISTS "fk_org_units_parent_id_org";
--> statement-breakpoint
ALTER TABLE public.org_unit_members DROP CONSTRAINT IF EXISTS "fk_org_unit_members_org_unit_id_org";
--> statement-breakpoint
ALTER TABLE public.operator_access_log DROP CONSTRAINT IF EXISTS "fk_operator_access_log_grant_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_templates DROP CONSTRAINT IF EXISTS "fk_onboarding_templates_department_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps DROP CONSTRAINT IF EXISTS "fk_onboarding_template_steps_template_id_org";
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps
  ADD CONSTRAINT "fk_onboarding_template_steps_template_id_org"
  FOREIGN KEY (org_id, template_id)
  REFERENCES public.onboarding_templates (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.nps_responses DROP CONSTRAINT IF EXISTS "fk_nps_responses_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.nps_responses
  ADD CONSTRAINT "fk_nps_responses_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.nps_surveys (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_queue DROP CONSTRAINT IF EXISTS "fk_notification_queue_delivery_id_org";
--> statement-breakpoint
ALTER TABLE public.notification_queue
  ADD CONSTRAINT "fk_notification_queue_delivery_id_org"
  FOREIGN KEY ("org_id", "delivery_id") REFERENCES "notification_deliveries"("org_id", "id")
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_audit_logs DROP CONSTRAINT IF EXISTS "fk_notification_audit_logs_broadcast_id_org";
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items DROP CONSTRAINT IF EXISTS "fk_module_setup_checklist_items_checklist_id_org";
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items
  ADD CONSTRAINT "fk_module_setup_checklist_items_checklist_id_org"
  FOREIGN KEY (org_id, checklist_id)
  REFERENCES public.module_setup_checklists (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.legal_entities DROP CONSTRAINT IF EXISTS "fk_legal_entities_parent_legal_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.legal_entities DROP CONSTRAINT IF EXISTS "fk_legal_entities_org_unit_id_org";
--> statement-breakpoint
ALTER TABLE public.key_results DROP CONSTRAINT IF EXISTS "fk_key_results_goal_id_org";
--> statement-breakpoint
ALTER TABLE public.key_results
  ADD CONSTRAINT "fk_key_results_goal_id_org"
  FOREIGN KEY (org_id, goal_id)
  REFERENCES public.goals (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_space_grants DROP CONSTRAINT IF EXISTS "fk_kb_space_grants_space_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_comments DROP CONSTRAINT IF EXISTS "fk_kb_article_comments_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_article_comments
  ADD CONSTRAINT "fk_kb_article_comments_article_id_org"
  FOREIGN KEY (org_id, article_id)
  REFERENCES public.kb_articles (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.journal_lines DROP CONSTRAINT IF EXISTS "fk_journal_lines_department_id_org";
--> statement-breakpoint
ALTER TABLE public.journal_lines DROP CONSTRAINT IF EXISTS "fk_journal_lines_account_id_org";
--> statement-breakpoint
ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS "fk_invoice_items_invoice_id_org";
--> statement-breakpoint
ALTER TABLE public.invoice_items
  ADD CONSTRAINT "fk_invoice_items_invoice_id_org"
  FOREIGN KEY (org_id, invoice_id)
  REFERENCES public.invoices (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS "fk_invitations_revoked_by_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS "fk_invitations_inviter_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS "fk_invitations_accepted_membership_id_org";
--> statement-breakpoint
ALTER TABLE public.invitation_events DROP CONSTRAINT IF EXISTS "fk_invitation_events_invitation_id_org";
--> statement-breakpoint
ALTER TABLE public.incentives DROP CONSTRAINT IF EXISTS "fk_incentives_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.incentive_config DROP CONSTRAINT IF EXISTS "fk_incentive_config_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_periods DROP CONSTRAINT IF EXISTS "fk_gl_periods_fiscal_year_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_periods DROP CONSTRAINT IF EXISTS "fk_gl_periods_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT IF EXISTS "fk_gl_parties_default_income_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT IF EXISTS "fk_gl_parties_default_expense_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_parties DROP CONSTRAINT IF EXISTS "fk_gl_parties_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT IF EXISTS "fk_gl_journals_reverses_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT IF EXISTS "fk_gl_journals_reversed_by_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT IF EXISTS "fk_gl_journals_period_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journals DROP CONSTRAINT IF EXISTS "fk_gl_journals_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_journal_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_fx_rate_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_dimension_project_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_dimension_branch_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_journal_lines DROP CONSTRAINT IF EXISTS "fk_gl_journal_lines_account_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_fx_rates DROP CONSTRAINT IF EXISTS "fk_gl_fx_rates_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_fiscal_years DROP CONSTRAINT IF EXISTS "fk_gl_fiscal_years_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences DROP CONSTRAINT IF EXISTS "fk_gl_document_sequences_fiscal_year_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_sequences DROP CONSTRAINT IF EXISTS "fk_gl_document_sequences_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_compliance DROP CONSTRAINT IF EXISTS "fk_gl_document_compliance_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_document_attachments DROP CONSTRAINT IF EXISTS "fk_gl_document_attachments_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_books DROP CONSTRAINT IF EXISTS "fk_gl_books_parent_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_books DROP CONSTRAINT IF EXISTS "fk_gl_books_legal_entity_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_book_currencies DROP CONSTRAINT IF EXISTS "fk_gl_book_currencies_book_id_org";
--> statement-breakpoint
ALTER TABLE public.gl_accounts DROP CONSTRAINT IF EXISTS "fk_gl_accounts_parent_account_id_org";

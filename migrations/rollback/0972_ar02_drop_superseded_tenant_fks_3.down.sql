-- 0972_ar02_drop_superseded_tenant_fks_3 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.support_ticket_attachments
  ADD CONSTRAINT "support_ticket_attachments_message_id_fkey"
  FOREIGN KEY (message_id) REFERENCES public.support_ticket_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_activity
  ADD CONSTRAINT "support_ticket_activity_support_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (support_ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_message_mentions
  ADD CONSTRAINT "support_message_mentions_message_id_support_ticket_messages_id_"
  FOREIGN KEY (message_id) REFERENCES public.support_ticket_messages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_knowledge_gaps
  ADD CONSTRAINT "support_knowledge_gaps_proposed_article_id_kb_articles_id_fk"
  FOREIGN KEY (proposed_article_id) REFERENCES public.kb_articles (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_csat_requests
  ADD CONSTRAINT "support_csat_requests_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ai_suggestions
  ADD CONSTRAINT "support_ai_suggestions_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets
  ADD CONSTRAINT "sign_signature_assets_recipient_id_sign_recipients_id_fk"
  FOREIGN KEY (recipient_id) REFERENCES public.sign_recipients (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets
  ADD CONSTRAINT "sign_signature_assets_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_recipients
  ADD CONSTRAINT "sign_recipients_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_public_forms
  ADD CONSTRAINT "sign_public_forms_template_id_sign_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES public.sign_templates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "sign_fields_recipient_id_sign_recipients_id_fk"
  FOREIGN KEY (recipient_id) REFERENCES public.sign_recipients (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "sign_fields_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_fields
  ADD CONSTRAINT "sign_fields_document_id_sign_documents_id_fk"
  FOREIGN KEY (document_id) REFERENCES public.sign_documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "sign_envelopes_watermark_policy_id_sign_watermark_policies_id_f"
  FOREIGN KEY (watermark_policy_id) REFERENCES public.sign_watermark_policies (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "sign_envelopes_template_id_sign_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES public.sign_templates (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_envelopes
  ADD CONSTRAINT "sign_envelopes_public_form_id_sign_public_forms_id_fk"
  FOREIGN KEY (public_form_id) REFERENCES public.sign_public_forms (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_documents
  ADD CONSTRAINT "sign_documents_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_certificates
  ADD CONSTRAINT "sign_certificates_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows
  ADD CONSTRAINT "sign_bulk_send_rows_job_id_sign_bulk_send_jobs_id_fk"
  FOREIGN KEY (job_id) REFERENCES public.sign_bulk_send_jobs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows
  ADD CONSTRAINT "sign_bulk_send_rows_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_jobs
  ADD CONSTRAINT "sign_bulk_send_jobs_template_id_sign_templates_id_fk"
  FOREIGN KEY (template_id) REFERENCES public.sign_templates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_audit_events
  ADD CONSTRAINT "sign_audit_events_recipient_id_sign_recipients_id_fk"
  FOREIGN KEY (recipient_id) REFERENCES public.sign_recipients (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.sign_audit_events
  ADD CONSTRAINT "sign_audit_events_envelope_id_sign_envelopes_id_fk"
  FOREIGN KEY (envelope_id) REFERENCES public.sign_envelopes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.role_permission_grants
  ADD CONSTRAINT "role_permission_grants_role_id_roles_id_fk"
  FOREIGN KEY (role_id) REFERENCES public.roles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.role_assignments
  ADD CONSTRAINT "ra_role_fk"
  FOREIGN KEY (role_id) REFERENCES public.roles (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.purchase_bill_items
  ADD CONSTRAINT "purchase_bill_items_bill_id_purchase_bills_id_fk"
  FOREIGN KEY (bill_id) REFERENCES public.purchase_bills (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.principal_groups
  ADD CONSTRAINT "principal_groups_org_unit_id_fkey"
  FOREIGN KEY (org_unit_id) REFERENCES public.org_units (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.principal_group_members
  ADD CONSTRAINT "principal_group_members_principal_group_id_fkey"
  FOREIGN KEY (principal_group_id) REFERENCES public.principal_groups (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.policy_acknowledgments
  ADD CONSTRAINT "policy_acknowledgments_document_id_documents_id_fk"
  FOREIGN KEY (document_id) REFERENCES public.documents (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_reviews
  ADD CONSTRAINT "performance_reviews_cycle_id_review_cycles_id_fk"
  FOREIGN KEY (cycle_id) REFERENCES public.review_cycles (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "payslip_publications_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "payslip_publications_run_employee_id_payroll_run_employees_id_f"
  FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payslip_publications
  ADD CONSTRAINT "payslip_publications_payslip_template_id_payslip_templates_id_f"
  FOREIGN KEY (payslip_template_id) REFERENCES public.payslip_templates (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_template_activations
  ADD CONSTRAINT "payroll_template_activations_policy_version_id_payroll_policy_v"
  FOREIGN KEY (policy_version_id) REFERENCES public.payroll_policy_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_statutory_rule_sets
  ADD CONSTRAINT "payroll_statutory_rule_sets_entity_id_fkey"
  FOREIGN KEY (entity_id) REFERENCES public.payroll_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_runs
  ADD CONSTRAINT "payroll_runs_policy_version_id_payroll_policy_versions_id_fk"
  FOREIGN KEY (policy_version_id) REFERENCES public.payroll_policy_versions (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_run_events
  ADD CONSTRAINT "payroll_run_events_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_policy_versions
  ADD CONSTRAINT "payroll_policy_versions_policy_id_payroll_policies_id_fk"
  FOREIGN KEY (policy_id) REFERENCES public.payroll_policies (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_periods
  ADD CONSTRAINT "payroll_periods_entity_id_fkey"
  FOREIGN KEY (entity_id) REFERENCES public.payroll_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments
  ADD CONSTRAINT "payroll_loan_adjustments_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments
  ADD CONSTRAINT "payroll_loan_adjustments_loan_id_salary_loans_id_fk"
  FOREIGN KEY (loan_id) REFERENCES public.salary_loans (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_line_items
  ADD CONSTRAINT "payroll_line_items_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_line_items
  ADD CONSTRAINT "payroll_line_items_run_employee_id_payroll_run_employees_id_fk"
  FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "payroll_journal_batches_run_id_fkey"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "fk_payroll_journal_batches_reversal_of_batch_id_org"
  FOREIGN KEY (org_id, reversal_of_batch_id) REFERENCES public.payroll_journal_batches (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "payroll_journal_batches_reversal_of_batch_id_fkey"
  FOREIGN KEY (reversal_of_batch_id) REFERENCES public.payroll_journal_batches (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches
  ADD CONSTRAINT "payroll_journal_batches_entity_id_fkey"
  FOREIGN KEY (entity_id) REFERENCES public.payroll_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batch_lines
  ADD CONSTRAINT "payroll_journal_batch_lines_batch_id_fkey"
  FOREIGN KEY (batch_id) REFERENCES public.payroll_journal_batches (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_jobs
  ADD CONSTRAINT "payroll_jobs_entity_id_fkey"
  FOREIGN KEY (entity_id) REFERENCES public.payroll_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_inputs
  ADD CONSTRAINT "payroll_inputs_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_filings
  ADD CONSTRAINT "payroll_filings_period_id_fkey"
  FOREIGN KEY (period_id) REFERENCES public.payroll_periods (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_filings
  ADD CONSTRAINT "payroll_filings_entity_id_fkey"
  FOREIGN KEY (entity_id) REFERENCES public.payroll_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions
  ADD CONSTRAINT "payroll_exceptions_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions
  ADD CONSTRAINT "payroll_exceptions_run_employee_id_payroll_run_employees_id_fk"
  FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_entities
  ADD CONSTRAINT "payroll_entities_legal_entity_id_fkey"
  FOREIGN KEY (legal_entity_id) REFERENCES public.legal_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_command_receipts
  ADD CONSTRAINT "payroll_command_receipts_run_id_fkey"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_calendar_events
  ADD CONSTRAINT "payroll_calendar_events_policy_id_payroll_policies_id_fk"
  FOREIGN KEY (policy_id) REFERENCES public.payroll_policies (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batches
  ADD CONSTRAINT "payroll_bank_batches_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items
  ADD CONSTRAINT "payroll_bank_batch_items_run_employee_id_payroll_run_employees_"
  FOREIGN KEY (run_employee_id) REFERENCES public.payroll_run_employees (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items
  ADD CONSTRAINT "payroll_bank_batch_items_batch_id_payroll_bank_batches_id_fk"
  FOREIGN KEY (batch_id) REFERENCES public.payroll_bank_batches (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payroll_approvals
  ADD CONSTRAINT "payroll_approvals_run_id_payroll_runs_id_fk"
  FOREIGN KEY (run_id) REFERENCES public.payroll_runs (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payments
  ADD CONSTRAINT "payments_invoice_id_invoices_id_fk"
  FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_webhook_events
  ADD CONSTRAINT "payment_webhook_events_provider_id_payment_providers_id_fk"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_webhook_endpoints
  ADD CONSTRAINT "payment_webhook_endpoints_provider_id_payment_providers_id_fk"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_test_transactions
  ADD CONSTRAINT "payment_test_transactions_provider_id_payment_providers_id_fk"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_provider_credentials
  ADD CONSTRAINT "payment_provider_credentials_provider_id_payment_providers_id_f"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_provider_accounts
  ADD CONSTRAINT "payment_provider_accounts_provider_id_payment_providers_id_fk"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.payment_audit_events
  ADD CONSTRAINT "payment_audit_events_provider_id_payment_providers_id_fk"
  FOREIGN KEY (provider_id) REFERENCES public.payment_providers (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.org_units
  ADD CONSTRAINT "org_units_parent_id_fkey"
  FOREIGN KEY (parent_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.org_unit_members
  ADD CONSTRAINT "org_unit_members_org_unit_id_fkey"
  FOREIGN KEY (org_unit_id) REFERENCES public.org_units (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.operator_access_log
  ADD CONSTRAINT "operator_access_log_grant_id_fkey"
  FOREIGN KEY (grant_id) REFERENCES public.operator_access_grants (grant_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_templates
  ADD CONSTRAINT "onboarding_templates_department_id_org_units_id_fk"
  FOREIGN KEY (department_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps
  ADD CONSTRAINT "onboarding_template_steps_template_id_onboarding_templates_id_f"
  FOREIGN KEY (template_id) REFERENCES public.onboarding_templates (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_tasks
  ADD CONSTRAINT "onboarding_tasks_template_step_id_onboarding_template_steps_id_"
  FOREIGN KEY (template_step_id) REFERENCES public.onboarding_template_steps (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.onboarding_documents
  ADD CONSTRAINT "onboarding_documents_document_type_id_document_types_id_fk"
  FOREIGN KEY (document_type_id) REFERENCES public.document_types (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.nps_responses
  ADD CONSTRAINT "nps_responses_survey_id_nps_surveys_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.nps_surveys (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_queue
  ADD CONSTRAINT "notification_queue_delivery_id_notification_deliveries_id_fk"
  FOREIGN KEY (delivery_id) REFERENCES public.notification_deliveries (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notification_audit_logs
  ADD CONSTRAINT "fk_notification_audit_logs_broadcast"
  FOREIGN KEY (broadcast_id) REFERENCES public.broadcasts (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items
  ADD CONSTRAINT "module_setup_checklist_items_checklist_id_module_setup_checklis"
  FOREIGN KEY (checklist_id) REFERENCES public.module_setup_checklists (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.legal_entities
  ADD CONSTRAINT "legal_entities_parent_legal_entity_id_fkey"
  FOREIGN KEY (parent_legal_entity_id) REFERENCES public.legal_entities (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.legal_entities
  ADD CONSTRAINT "legal_entities_org_unit_id_fkey"
  FOREIGN KEY (org_unit_id) REFERENCES public.org_units (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.key_results
  ADD CONSTRAINT "key_results_goal_id_goals_id_fk"
  FOREIGN KEY (goal_id) REFERENCES public.goals (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_space_members
  ADD CONSTRAINT "fk_kb_space_members_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_space_members
  ADD CONSTRAINT "kb_space_members_space_id_kb_spaces_id_fk"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_space_grants
  ADD CONSTRAINT "fk_kb_space_grants_space"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_sources
  ADD CONSTRAINT "fk_kb_sources_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_sources
  ADD CONSTRAINT "kb_sources_space_id_kb_spaces_id_fk"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_pages
  ADD CONSTRAINT "fk_kb_pages_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_pages
  ADD CONSTRAINT "kb_pages_space_id_kb_spaces_id_fk"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_pages
  ADD CONSTRAINT "fk_kb_pages_project_id_org"
  FOREIGN KEY (org_id, project_id) REFERENCES build.projects (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_pages
  ADD CONSTRAINT "kb_pages_project_id_fkey"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_visits
  ADD CONSTRAINT "fk_kb_page_visits_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_visits
  ADD CONSTRAINT "kb_page_visits_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_versions
  ADD CONSTRAINT "fk_kb_page_versions_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_versions
  ADD CONSTRAINT "kb_page_versions_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_reviews
  ADD CONSTRAINT "fk_kb_page_reviews_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_reviews
  ADD CONSTRAINT "kb_page_reviews_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_links
  ADD CONSTRAINT "kb_page_links_target_page_id_kb_pages_id_fk"
  FOREIGN KEY (target_page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_links
  ADD CONSTRAINT "fk_kb_page_links_source_page_id_org"
  FOREIGN KEY (org_id, source_page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_links
  ADD CONSTRAINT "kb_page_links_source_page_id_kb_pages_id_fk"
  FOREIGN KEY (source_page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_favorites
  ADD CONSTRAINT "fk_kb_page_favorites_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_favorites
  ADD CONSTRAINT "kb_page_favorites_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_comments
  ADD CONSTRAINT "fk_kb_page_comments_page_id_org"
  FOREIGN KEY (org_id, page_id) REFERENCES public.kb_pages (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_page_comments
  ADD CONSTRAINT "kb_page_comments_page_id_kb_pages_id_fk"
  FOREIGN KEY (page_id) REFERENCES public.kb_pages (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_events
  ADD CONSTRAINT "fk_kb_events_article_id_org"
  FOREIGN KEY (org_id, article_id) REFERENCES public.kb_articles (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_events
  ADD CONSTRAINT "kb_events_article_id_kb_articles_id_fk"
  FOREIGN KEY (article_id) REFERENCES public.kb_articles (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_chat_messages
  ADD CONSTRAINT "fk_kb_chat_messages_conversation_id_org"
  FOREIGN KEY (org_id, conversation_id) REFERENCES public.kb_chat_conversations (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_chat_messages
  ADD CONSTRAINT "kb_chat_messages_conversation_id_kb_chat_conversations_id_fk"
  FOREIGN KEY (conversation_id) REFERENCES public.kb_chat_conversations (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_categories
  ADD CONSTRAINT "fk_kb_categories_space_id_org"
  FOREIGN KEY (org_id, space_id) REFERENCES public.kb_spaces (org_id, id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.kb_categories
  ADD CONSTRAINT "kb_categories_space_id_kb_spaces_id_fk"
  FOREIGN KEY (space_id) REFERENCES public.kb_spaces (id) ON DELETE CASCADE
  NOT VALID;

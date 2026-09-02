-- AR-02: drop the single-column and duplicate composite tenant foreign keys superseded by the canonical composites, part 3 of 4.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.kb_categories DROP CONSTRAINT "kb_categories_space_id_kb_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_categories DROP CONSTRAINT "fk_kb_categories_space_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_chat_messages DROP CONSTRAINT "kb_chat_messages_conversation_id_kb_chat_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_chat_messages DROP CONSTRAINT "fk_kb_chat_messages_conversation_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_events DROP CONSTRAINT "kb_events_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_events DROP CONSTRAINT "fk_kb_events_article_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_comments DROP CONSTRAINT "kb_page_comments_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_comments DROP CONSTRAINT "fk_kb_page_comments_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_favorites DROP CONSTRAINT "kb_page_favorites_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_favorites DROP CONSTRAINT "fk_kb_page_favorites_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_links DROP CONSTRAINT "kb_page_links_source_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_links DROP CONSTRAINT "fk_kb_page_links_source_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_links DROP CONSTRAINT "kb_page_links_target_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_reviews DROP CONSTRAINT "kb_page_reviews_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_reviews DROP CONSTRAINT "fk_kb_page_reviews_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_versions DROP CONSTRAINT "kb_page_versions_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_versions DROP CONSTRAINT "fk_kb_page_versions_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_page_visits DROP CONSTRAINT "kb_page_visits_page_id_kb_pages_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_page_visits DROP CONSTRAINT "fk_kb_page_visits_page_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_pages DROP CONSTRAINT "kb_pages_project_id_fkey";
--> statement-breakpoint
ALTER TABLE public.kb_pages DROP CONSTRAINT "fk_kb_pages_project_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_pages DROP CONSTRAINT "kb_pages_space_id_kb_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_pages DROP CONSTRAINT "fk_kb_pages_space_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_sources DROP CONSTRAINT "kb_sources_space_id_kb_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_sources DROP CONSTRAINT "fk_kb_sources_space_id_org";
--> statement-breakpoint
ALTER TABLE public.kb_space_grants DROP CONSTRAINT "fk_kb_space_grants_space";
--> statement-breakpoint
ALTER TABLE public.kb_space_members DROP CONSTRAINT "kb_space_members_space_id_kb_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE public.kb_space_members DROP CONSTRAINT "fk_kb_space_members_space_id_org";
--> statement-breakpoint
ALTER TABLE public.key_results DROP CONSTRAINT "key_results_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE public.legal_entities DROP CONSTRAINT "legal_entities_org_unit_id_fkey";
--> statement-breakpoint
ALTER TABLE public.legal_entities DROP CONSTRAINT "legal_entities_parent_legal_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.module_setup_checklist_items DROP CONSTRAINT "module_setup_checklist_items_checklist_id_module_setup_checklis";
--> statement-breakpoint
ALTER TABLE public.notification_audit_logs DROP CONSTRAINT "fk_notification_audit_logs_broadcast";
--> statement-breakpoint
ALTER TABLE public.notification_queue DROP CONSTRAINT "notification_queue_delivery_id_notification_deliveries_id_fk";
--> statement-breakpoint
ALTER TABLE public.nps_responses DROP CONSTRAINT "nps_responses_survey_id_nps_surveys_id_fk";
--> statement-breakpoint
ALTER TABLE public.onboarding_documents DROP CONSTRAINT "onboarding_documents_document_type_id_document_types_id_fk";
--> statement-breakpoint
ALTER TABLE public.onboarding_tasks DROP CONSTRAINT "onboarding_tasks_template_step_id_onboarding_template_steps_id_";
--> statement-breakpoint
ALTER TABLE public.onboarding_template_steps DROP CONSTRAINT "onboarding_template_steps_template_id_onboarding_templates_id_f";
--> statement-breakpoint
ALTER TABLE public.onboarding_templates DROP CONSTRAINT "onboarding_templates_department_id_org_units_id_fk";
--> statement-breakpoint
ALTER TABLE public.operator_access_log DROP CONSTRAINT "operator_access_log_grant_id_fkey";
--> statement-breakpoint
ALTER TABLE public.org_unit_members DROP CONSTRAINT "org_unit_members_org_unit_id_fkey";
--> statement-breakpoint
ALTER TABLE public.org_units DROP CONSTRAINT "org_units_parent_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payment_audit_events DROP CONSTRAINT "payment_audit_events_provider_id_payment_providers_id_fk";
--> statement-breakpoint
ALTER TABLE public.payment_provider_accounts DROP CONSTRAINT "payment_provider_accounts_provider_id_payment_providers_id_fk";
--> statement-breakpoint
ALTER TABLE public.payment_provider_credentials DROP CONSTRAINT "payment_provider_credentials_provider_id_payment_providers_id_f";
--> statement-breakpoint
ALTER TABLE public.payment_test_transactions DROP CONSTRAINT "payment_test_transactions_provider_id_payment_providers_id_fk";
--> statement-breakpoint
ALTER TABLE public.payment_webhook_endpoints DROP CONSTRAINT "payment_webhook_endpoints_provider_id_payment_providers_id_fk";
--> statement-breakpoint
ALTER TABLE public.payment_webhook_events DROP CONSTRAINT "payment_webhook_events_provider_id_payment_providers_id_fk";
--> statement-breakpoint
ALTER TABLE public.payments DROP CONSTRAINT "payments_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_approvals DROP CONSTRAINT "payroll_approvals_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items DROP CONSTRAINT "payroll_bank_batch_items_batch_id_payroll_bank_batches_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batch_items DROP CONSTRAINT "payroll_bank_batch_items_run_employee_id_payroll_run_employees_";
--> statement-breakpoint
ALTER TABLE public.payroll_bank_batches DROP CONSTRAINT "payroll_bank_batches_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_calendar_events DROP CONSTRAINT "payroll_calendar_events_policy_id_payroll_policies_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_command_receipts DROP CONSTRAINT "payroll_command_receipts_run_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_entities DROP CONSTRAINT "payroll_entities_legal_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions DROP CONSTRAINT "payroll_exceptions_run_employee_id_payroll_run_employees_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_exceptions DROP CONSTRAINT "payroll_exceptions_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_filings DROP CONSTRAINT "payroll_filings_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_filings DROP CONSTRAINT "payroll_filings_period_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_inputs DROP CONSTRAINT "payroll_inputs_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_jobs DROP CONSTRAINT "payroll_jobs_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batch_lines DROP CONSTRAINT "payroll_journal_batch_lines_batch_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT "payroll_journal_batches_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT "payroll_journal_batches_reversal_of_batch_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT "fk_payroll_journal_batches_reversal_of_batch_id_org";
--> statement-breakpoint
ALTER TABLE public.payroll_journal_batches DROP CONSTRAINT "payroll_journal_batches_run_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_line_items DROP CONSTRAINT "payroll_line_items_run_employee_id_payroll_run_employees_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_line_items DROP CONSTRAINT "payroll_line_items_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments DROP CONSTRAINT "payroll_loan_adjustments_loan_id_salary_loans_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_loan_adjustments DROP CONSTRAINT "payroll_loan_adjustments_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_periods DROP CONSTRAINT "payroll_periods_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_policy_versions DROP CONSTRAINT "payroll_policy_versions_policy_id_payroll_policies_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_run_events DROP CONSTRAINT "payroll_run_events_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_runs DROP CONSTRAINT "payroll_runs_policy_version_id_payroll_policy_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.payroll_statutory_rule_sets DROP CONSTRAINT "payroll_statutory_rule_sets_entity_id_fkey";
--> statement-breakpoint
ALTER TABLE public.payroll_template_activations DROP CONSTRAINT "payroll_template_activations_policy_version_id_payroll_policy_v";
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT "payslip_publications_payslip_template_id_payslip_templates_id_f";
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT "payslip_publications_run_employee_id_payroll_run_employees_id_f";
--> statement-breakpoint
ALTER TABLE public.payslip_publications DROP CONSTRAINT "payslip_publications_run_id_payroll_runs_id_fk";
--> statement-breakpoint
ALTER TABLE public.performance_reviews DROP CONSTRAINT "performance_reviews_cycle_id_review_cycles_id_fk";
--> statement-breakpoint
ALTER TABLE public.policy_acknowledgments DROP CONSTRAINT "policy_acknowledgments_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE public.principal_group_members DROP CONSTRAINT "principal_group_members_principal_group_id_fkey";
--> statement-breakpoint
ALTER TABLE public.principal_groups DROP CONSTRAINT "principal_groups_org_unit_id_fkey";
--> statement-breakpoint
ALTER TABLE public.purchase_bill_items DROP CONSTRAINT "purchase_bill_items_bill_id_purchase_bills_id_fk";
--> statement-breakpoint
ALTER TABLE public.role_assignments DROP CONSTRAINT "ra_role_fk";
--> statement-breakpoint
ALTER TABLE public.role_permission_grants DROP CONSTRAINT "role_permission_grants_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_audit_events DROP CONSTRAINT "sign_audit_events_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_audit_events DROP CONSTRAINT "sign_audit_events_recipient_id_sign_recipients_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_jobs DROP CONSTRAINT "sign_bulk_send_jobs_template_id_sign_templates_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows DROP CONSTRAINT "sign_bulk_send_rows_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_bulk_send_rows DROP CONSTRAINT "sign_bulk_send_rows_job_id_sign_bulk_send_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_certificates DROP CONSTRAINT "sign_certificates_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_documents DROP CONSTRAINT "sign_documents_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT "sign_envelopes_public_form_id_sign_public_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT "sign_envelopes_template_id_sign_templates_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_envelopes DROP CONSTRAINT "sign_envelopes_watermark_policy_id_sign_watermark_policies_id_f";
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT "sign_fields_document_id_sign_documents_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT "sign_fields_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_fields DROP CONSTRAINT "sign_fields_recipient_id_sign_recipients_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_public_forms DROP CONSTRAINT "sign_public_forms_template_id_sign_templates_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_recipients DROP CONSTRAINT "sign_recipients_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets DROP CONSTRAINT "sign_signature_assets_envelope_id_sign_envelopes_id_fk";
--> statement-breakpoint
ALTER TABLE public.sign_signature_assets DROP CONSTRAINT "sign_signature_assets_recipient_id_sign_recipients_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ai_suggestions DROP CONSTRAINT "support_ai_suggestions_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_csat_requests DROP CONSTRAINT "support_csat_requests_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_knowledge_gaps DROP CONSTRAINT "support_knowledge_gaps_proposed_article_id_kb_articles_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_message_mentions DROP CONSTRAINT "support_message_mentions_message_id_support_ticket_messages_id_";
--> statement-breakpoint
ALTER TABLE public.support_ticket_activity DROP CONSTRAINT "support_ticket_activity_support_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_attachments DROP CONSTRAINT "support_ticket_attachments_message_id_fkey";

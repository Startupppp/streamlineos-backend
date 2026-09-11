-- 0973_ar02_drop_superseded_tenant_fks_4 DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.webhook_logs
  ADD CONSTRAINT "webhook_logs_endpoint_id_webhook_endpoints_id_fk"
  FOREIGN KEY (endpoint_id) REFERENCES public.webhook_endpoints (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.vendor_payments
  ADD CONSTRAINT "vendor_payments_bill_id_purchase_bills_id_fk"
  FOREIGN KEY (bill_id) REFERENCES public.purchase_bills (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timesheets
  ADD CONSTRAINT "timesheets_payroll_export_id_timesheet_exports_id_fk"
  FOREIGN KEY (payroll_export_id) REFERENCES public.timesheet_exports (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.timer_sessions
  ADD CONSTRAINT "timer_sessions_project_id_projects_id_fk"
  FOREIGN KEY (project_id) REFERENCES build.projects (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.team_event_participants
  ADD CONSTRAINT "team_event_participants_event_id_team_events_id_fk"
  FOREIGN KEY (event_id) REFERENCES public.team_events (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_registrations
  ADD CONSTRAINT "fk_tax_registrations_party"
  FOREIGN KEY (party_id) REFERENCES public.gl_parties (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_registrations
  ADD CONSTRAINT "tax_registrations_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_rates
  ADD CONSTRAINT "tax_rates_tax_code_id_fkey"
  FOREIGN KEY (tax_code_id) REFERENCES public.tax_codes (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_gl_map
  ADD CONSTRAINT "tax_gl_map_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_gl_map
  ADD CONSTRAINT "tax_gl_map_account_id_fkey"
  FOREIGN KEY (account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "tax_document_lines_tax_code_id_fkey"
  FOREIGN KEY (tax_code_id) REFERENCES public.tax_codes (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "tax_document_lines_gl_account_id_fkey"
  FOREIGN KEY (gl_account_id) REFERENCES public.gl_accounts (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_document_lines
  ADD CONSTRAINT "tax_document_lines_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tax_codes
  ADD CONSTRAINT "tax_codes_book_id_fkey"
  FOREIGN KEY (book_id) REFERENCES public.gl_books (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.tasks
  ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk"
  FOREIGN KEY (parent_task_id) REFERENCES public.tasks (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps
  ADD CONSTRAINT "task_sequence_steps_sequence_id_task_sequences_id_fk"
  FOREIGN KEY (sequence_id) REFERENCES public.task_sequences (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_versions
  ADD CONSTRAINT "survey_versions_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_sections
  ADD CONSTRAINT "survey_sections_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_sections
  ADD CONSTRAINT "survey_sections_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_responses
  ADD CONSTRAINT "survey_responses_survey_id_pulse_surveys_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.pulse_surveys (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "survey_response_sessions_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "survey_response_sessions_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "survey_response_sessions_participant_id_survey_participants_id_"
  FOREIGN KEY (participant_id) REFERENCES public.survey_participants (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "survey_response_sessions_collector_id_survey_collectors_id_fk"
  FOREIGN KEY (collector_id) REFERENCES public.survey_collectors (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "survey_questions_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "survey_questions_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "survey_questions_section_id_survey_sections_id_fk"
  FOREIGN KEY (section_id) REFERENCES public.survey_sections (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_question_choices
  ADD CONSTRAINT "survey_question_choices_question_id_survey_questions_id_fk"
  FOREIGN KEY (question_id) REFERENCES public.survey_questions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_participants
  ADD CONSTRAINT "survey_participants_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_participants
  ADD CONSTRAINT "survey_participants_collector_id_survey_collectors_id_fk"
  FOREIGN KEY (collector_id) REFERENCES public.survey_collectors (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "survey_logic_rules_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "survey_logic_rules_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "survey_logic_rules_source_question_id_survey_questions_id_fk"
  FOREIGN KEY (source_question_id) REFERENCES public.survey_questions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "survey_live_sessions_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "survey_live_sessions_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "survey_live_sessions_current_question_id_survey_questions_id_fk"
  FOREIGN KEY (current_question_id) REFERENCES public.survey_questions (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_collectors
  ADD CONSTRAINT "survey_collectors_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_collectors
  ADD CONSTRAINT "survey_collectors_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "survey_certificates_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "survey_certificates_participant_id_survey_participants_id_fk"
  FOREIGN KEY (participant_id) REFERENCES public.survey_participants (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "survey_certificates_attempt_id_survey_assessment_attempts_id_fk"
  FOREIGN KEY (attempt_id) REFERENCES public.survey_assessment_attempts (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_automation_events
  ADD CONSTRAINT "survey_automation_events_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_automation_events
  ADD CONSTRAINT "survey_automation_events_session_id_survey_response_sessions_id"
  FOREIGN KEY (session_id) REFERENCES public.survey_response_sessions (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "survey_assessment_attempts_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "survey_assessment_attempts_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "survey_assessment_attempts_session_id_survey_response_sessions_"
  FOREIGN KEY (session_id) REFERENCES public.survey_response_sessions (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "survey_assessment_attempts_participant_id_survey_participants_i"
  FOREIGN KEY (participant_id) REFERENCES public.survey_participants (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "survey_answers_version_id_survey_versions_id_fk"
  FOREIGN KEY (version_id) REFERENCES public.survey_versions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "survey_answers_survey_id_survey_forms_id_fk"
  FOREIGN KEY (survey_id) REFERENCES public.survey_forms (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "survey_answers_session_id_survey_response_sessions_id_fk"
  FOREIGN KEY (session_id) REFERENCES public.survey_response_sessions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "survey_answers_question_id_survey_questions_id_fk"
  FOREIGN KEY (question_id) REFERENCES public.survey_questions (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_tickets
  ADD CONSTRAINT "fk_support_tickets_queue"
  FOREIGN KEY (queue_id) REFERENCES public.support_queues (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_watchers
  ADD CONSTRAINT "support_ticket_watchers_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags
  ADD CONSTRAINT "support_ticket_tags_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags
  ADD CONSTRAINT "support_ticket_tags_tag_id_support_tags_id_fk"
  FOREIGN KEY (tag_id) REFERENCES public.support_tags (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_messages
  ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_links
  ADD CONSTRAINT "support_ticket_links_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_links
  ADD CONSTRAINT "support_ticket_links_linked_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (linked_ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_external_links
  ADD CONSTRAINT "support_ticket_external_links_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_embeddings
  ADD CONSTRAINT "support_ticket_embeddings_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_drafts
  ADD CONSTRAINT "support_ticket_drafts_ticket_id_support_tickets_id_fk"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values
  ADD CONSTRAINT "support_ticket_custom_field_values_ticket_id_fkey"
  FOREIGN KEY (ticket_id) REFERENCES public.support_tickets (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values
  ADD CONSTRAINT "support_ticket_custom_field_values_field_definition_id_fkey"
  FOREIGN KEY (field_definition_id) REFERENCES public.custom_field_definitions (id) ON DELETE CASCADE
  NOT VALID;

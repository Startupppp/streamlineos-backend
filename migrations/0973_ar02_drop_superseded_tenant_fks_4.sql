-- AR-02: drop the single-column and duplicate composite tenant foreign keys superseded by the canonical composites, part 4 of 4.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values DROP CONSTRAINT IF EXISTS "support_ticket_custom_field_values_field_definition_id_fkey";
--> statement-breakpoint
ALTER TABLE public.support_ticket_custom_field_values DROP CONSTRAINT IF EXISTS "support_ticket_custom_field_values_ticket_id_fkey";
--> statement-breakpoint
ALTER TABLE public.support_ticket_drafts DROP CONSTRAINT IF EXISTS "support_ticket_drafts_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_embeddings DROP CONSTRAINT IF EXISTS "support_ticket_embeddings_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_external_links DROP CONSTRAINT IF EXISTS "support_ticket_external_links_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_links DROP CONSTRAINT IF EXISTS "support_ticket_links_linked_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_links DROP CONSTRAINT IF EXISTS "support_ticket_links_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_messages DROP CONSTRAINT IF EXISTS "support_ticket_messages_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags DROP CONSTRAINT IF EXISTS "support_ticket_tags_tag_id_support_tags_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags DROP CONSTRAINT IF EXISTS "support_ticket_tags_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_ticket_watchers DROP CONSTRAINT IF EXISTS "support_ticket_watchers_ticket_id_support_tickets_id_fk";
--> statement-breakpoint
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS "fk_support_tickets_queue";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "survey_answers_question_id_survey_questions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "survey_answers_session_id_survey_response_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "survey_answers_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "survey_answers_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "survey_assessment_attempts_participant_id_survey_participants_i";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "survey_assessment_attempts_session_id_survey_response_sessions_";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "survey_assessment_attempts_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "survey_assessment_attempts_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events DROP CONSTRAINT IF EXISTS "survey_automation_events_session_id_survey_response_sessions_id";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events DROP CONSTRAINT IF EXISTS "survey_automation_events_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "survey_certificates_attempt_id_survey_assessment_attempts_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "survey_certificates_participant_id_survey_participants_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "survey_certificates_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_collectors DROP CONSTRAINT IF EXISTS "survey_collectors_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_collectors DROP CONSTRAINT IF EXISTS "survey_collectors_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "survey_live_sessions_current_question_id_survey_questions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "survey_live_sessions_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "survey_live_sessions_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "survey_logic_rules_source_question_id_survey_questions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "survey_logic_rules_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "survey_logic_rules_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_participants DROP CONSTRAINT IF EXISTS "survey_participants_collector_id_survey_collectors_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_participants DROP CONSTRAINT IF EXISTS "survey_participants_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_question_choices DROP CONSTRAINT IF EXISTS "survey_question_choices_question_id_survey_questions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "survey_questions_section_id_survey_sections_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "survey_questions_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "survey_questions_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "survey_response_sessions_collector_id_survey_collectors_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "survey_response_sessions_participant_id_survey_participants_id_";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "survey_response_sessions_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "survey_response_sessions_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_responses DROP CONSTRAINT IF EXISTS "survey_responses_survey_id_pulse_surveys_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_sections DROP CONSTRAINT IF EXISTS "survey_sections_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_sections DROP CONSTRAINT IF EXISTS "survey_sections_version_id_survey_versions_id_fk";
--> statement-breakpoint
ALTER TABLE public.survey_versions DROP CONSTRAINT IF EXISTS "survey_versions_survey_id_survey_forms_id_fk";
--> statement-breakpoint
ALTER TABLE public.task_sequence_steps DROP CONSTRAINT IF EXISTS "task_sequence_steps_sequence_id_task_sequences_id_fk";
--> statement-breakpoint
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS "tasks_parent_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE public.tax_codes DROP CONSTRAINT IF EXISTS "tax_codes_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "tax_document_lines_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "tax_document_lines_gl_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_document_lines DROP CONSTRAINT IF EXISTS "tax_document_lines_tax_code_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map DROP CONSTRAINT IF EXISTS "tax_gl_map_account_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_gl_map DROP CONSTRAINT IF EXISTS "tax_gl_map_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_rates DROP CONSTRAINT IF EXISTS "tax_rates_tax_code_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_registrations DROP CONSTRAINT IF EXISTS "tax_registrations_book_id_fkey";
--> statement-breakpoint
ALTER TABLE public.tax_registrations DROP CONSTRAINT IF EXISTS "fk_tax_registrations_party";
--> statement-breakpoint
ALTER TABLE public.team_event_participants DROP CONSTRAINT IF EXISTS "team_event_participants_event_id_team_events_id_fk";
--> statement-breakpoint
ALTER TABLE public.timer_sessions DROP CONSTRAINT IF EXISTS "timer_sessions_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE public.timesheets DROP CONSTRAINT IF EXISTS "timesheets_payroll_export_id_timesheet_exports_id_fk";
--> statement-breakpoint
ALTER TABLE public.vendor_payments DROP CONSTRAINT IF EXISTS "vendor_payments_bill_id_purchase_bills_id_fk";
--> statement-breakpoint
ALTER TABLE public.webhook_logs DROP CONSTRAINT IF EXISTS "webhook_logs_endpoint_id_webhook_endpoints_id_fk";

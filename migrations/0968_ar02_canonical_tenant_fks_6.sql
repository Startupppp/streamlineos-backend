-- AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part 6 of 7; the referential action of the single-column constraint being superseded is preserved.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.support_ticket_tags VALIDATE CONSTRAINT "fk_support_ticket_tags_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_watchers DROP CONSTRAINT IF EXISTS "fk_support_ticket_watchers_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_ticket_watchers
  ADD CONSTRAINT "fk_support_ticket_watchers_ticket_id_org"
  FOREIGN KEY (org_id, ticket_id)
  REFERENCES public.support_tickets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_ticket_watchers VALIDATE CONSTRAINT "fk_support_ticket_watchers_ticket_id_org";
--> statement-breakpoint
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS "fk_support_tickets_queue_id_org";
--> statement-breakpoint
ALTER TABLE public.support_tickets
  ADD CONSTRAINT "fk_support_tickets_queue_id_org"
  FOREIGN KEY (org_id, queue_id)
  REFERENCES public.support_queues (org_id, id)
  ON DELETE SET NULL (queue_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.support_tickets VALIDATE CONSTRAINT "fk_support_tickets_queue_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "fk_survey_answers_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "fk_survey_answers_question_id_org"
  FOREIGN KEY (org_id, question_id)
  REFERENCES public.survey_questions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers VALIDATE CONSTRAINT "fk_survey_answers_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "fk_survey_answers_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "fk_survey_answers_session_id_org"
  FOREIGN KEY (org_id, session_id)
  REFERENCES public.survey_response_sessions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers VALIDATE CONSTRAINT "fk_survey_answers_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "fk_survey_answers_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "fk_survey_answers_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers VALIDATE CONSTRAINT "fk_survey_answers_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers DROP CONSTRAINT IF EXISTS "fk_survey_answers_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_answers
  ADD CONSTRAINT "fk_survey_answers_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_answers VALIDATE CONSTRAINT "fk_survey_answers_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "fk_survey_assessment_attempts_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "fk_survey_assessment_attempts_participant_id_org"
  FOREIGN KEY (org_id, participant_id)
  REFERENCES public.survey_participants (org_id, id)
  ON DELETE SET NULL (participant_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts VALIDATE CONSTRAINT "fk_survey_assessment_attempts_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "fk_survey_assessment_attempts_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "fk_survey_assessment_attempts_session_id_org"
  FOREIGN KEY (org_id, session_id)
  REFERENCES public.survey_response_sessions (org_id, id)
  ON DELETE SET NULL (session_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts VALIDATE CONSTRAINT "fk_survey_assessment_attempts_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "fk_survey_assessment_attempts_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "fk_survey_assessment_attempts_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts VALIDATE CONSTRAINT "fk_survey_assessment_attempts_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts DROP CONSTRAINT IF EXISTS "fk_survey_assessment_attempts_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts
  ADD CONSTRAINT "fk_survey_assessment_attempts_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_assessment_attempts VALIDATE CONSTRAINT "fk_survey_assessment_attempts_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events DROP CONSTRAINT IF EXISTS "fk_survey_automation_events_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events
  ADD CONSTRAINT "fk_survey_automation_events_session_id_org"
  FOREIGN KEY (org_id, session_id)
  REFERENCES public.survey_response_sessions (org_id, id)
  ON DELETE SET NULL (session_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_automation_events VALIDATE CONSTRAINT "fk_survey_automation_events_session_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events DROP CONSTRAINT IF EXISTS "fk_survey_automation_events_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_automation_events
  ADD CONSTRAINT "fk_survey_automation_events_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_automation_events VALIDATE CONSTRAINT "fk_survey_automation_events_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "fk_survey_certificates_attempt_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "fk_survey_certificates_attempt_id_org"
  FOREIGN KEY (org_id, attempt_id)
  REFERENCES public.survey_assessment_attempts (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates VALIDATE CONSTRAINT "fk_survey_certificates_attempt_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "fk_survey_certificates_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "fk_survey_certificates_participant_id_org"
  FOREIGN KEY (org_id, participant_id)
  REFERENCES public.survey_participants (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates VALIDATE CONSTRAINT "fk_survey_certificates_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates DROP CONSTRAINT IF EXISTS "fk_survey_certificates_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_certificates
  ADD CONSTRAINT "fk_survey_certificates_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_certificates VALIDATE CONSTRAINT "fk_survey_certificates_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_collectors DROP CONSTRAINT IF EXISTS "fk_survey_collectors_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_collectors
  ADD CONSTRAINT "fk_survey_collectors_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_collectors VALIDATE CONSTRAINT "fk_survey_collectors_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_collectors DROP CONSTRAINT IF EXISTS "fk_survey_collectors_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_collectors
  ADD CONSTRAINT "fk_survey_collectors_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE SET NULL (version_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_collectors VALIDATE CONSTRAINT "fk_survey_collectors_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "fk_survey_live_sessions_current_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "fk_survey_live_sessions_current_question_id_org"
  FOREIGN KEY (org_id, current_question_id)
  REFERENCES public.survey_questions (org_id, id)
  ON DELETE SET NULL (current_question_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions VALIDATE CONSTRAINT "fk_survey_live_sessions_current_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "fk_survey_live_sessions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "fk_survey_live_sessions_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions VALIDATE CONSTRAINT "fk_survey_live_sessions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions DROP CONSTRAINT IF EXISTS "fk_survey_live_sessions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions
  ADD CONSTRAINT "fk_survey_live_sessions_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_live_sessions VALIDATE CONSTRAINT "fk_survey_live_sessions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "fk_survey_logic_rules_source_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "fk_survey_logic_rules_source_question_id_org"
  FOREIGN KEY (org_id, source_question_id)
  REFERENCES public.survey_questions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules VALIDATE CONSTRAINT "fk_survey_logic_rules_source_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "fk_survey_logic_rules_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "fk_survey_logic_rules_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules VALIDATE CONSTRAINT "fk_survey_logic_rules_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules DROP CONSTRAINT IF EXISTS "fk_survey_logic_rules_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules
  ADD CONSTRAINT "fk_survey_logic_rules_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_logic_rules VALIDATE CONSTRAINT "fk_survey_logic_rules_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_participants DROP CONSTRAINT IF EXISTS "fk_survey_participants_collector_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_participants
  ADD CONSTRAINT "fk_survey_participants_collector_id_org"
  FOREIGN KEY (org_id, collector_id)
  REFERENCES public.survey_collectors (org_id, id)
  ON DELETE SET NULL (collector_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_participants VALIDATE CONSTRAINT "fk_survey_participants_collector_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_participants DROP CONSTRAINT IF EXISTS "fk_survey_participants_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_participants
  ADD CONSTRAINT "fk_survey_participants_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_participants VALIDATE CONSTRAINT "fk_survey_participants_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_question_choices DROP CONSTRAINT IF EXISTS "fk_survey_question_choices_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_question_choices
  ADD CONSTRAINT "fk_survey_question_choices_question_id_org"
  FOREIGN KEY (org_id, question_id)
  REFERENCES public.survey_questions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_question_choices VALIDATE CONSTRAINT "fk_survey_question_choices_question_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "fk_survey_questions_section_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "fk_survey_questions_section_id_org"
  FOREIGN KEY (org_id, section_id)
  REFERENCES public.survey_sections (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions VALIDATE CONSTRAINT "fk_survey_questions_section_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "fk_survey_questions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "fk_survey_questions_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions VALIDATE CONSTRAINT "fk_survey_questions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions DROP CONSTRAINT IF EXISTS "fk_survey_questions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_questions
  ADD CONSTRAINT "fk_survey_questions_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_questions VALIDATE CONSTRAINT "fk_survey_questions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "fk_survey_response_sessions_collector_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "fk_survey_response_sessions_collector_id_org"
  FOREIGN KEY (org_id, collector_id)
  REFERENCES public.survey_collectors (org_id, id)
  ON DELETE SET NULL (collector_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions VALIDATE CONSTRAINT "fk_survey_response_sessions_collector_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "fk_survey_response_sessions_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "fk_survey_response_sessions_participant_id_org"
  FOREIGN KEY (org_id, participant_id)
  REFERENCES public.survey_participants (org_id, id)
  ON DELETE SET NULL (participant_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions VALIDATE CONSTRAINT "fk_survey_response_sessions_participant_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "fk_survey_response_sessions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "fk_survey_response_sessions_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions VALIDATE CONSTRAINT "fk_survey_response_sessions_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions DROP CONSTRAINT IF EXISTS "fk_survey_response_sessions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions
  ADD CONSTRAINT "fk_survey_response_sessions_version_id_org"
  FOREIGN KEY (org_id, version_id)
  REFERENCES public.survey_versions (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_response_sessions VALIDATE CONSTRAINT "fk_survey_response_sessions_version_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_responses DROP CONSTRAINT IF EXISTS "fk_survey_responses_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_responses
  ADD CONSTRAINT "fk_survey_responses_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.pulse_surveys (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_responses VALIDATE CONSTRAINT "fk_survey_responses_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_sections DROP CONSTRAINT IF EXISTS "fk_survey_sections_survey_id_org";
--> statement-breakpoint
ALTER TABLE public.survey_sections
  ADD CONSTRAINT "fk_survey_sections_survey_id_org"
  FOREIGN KEY (org_id, survey_id)
  REFERENCES public.survey_forms (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE public.survey_sections VALIDATE CONSTRAINT "fk_survey_sections_survey_id_org";

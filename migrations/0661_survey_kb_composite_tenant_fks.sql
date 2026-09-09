-- =============================================================================
-- 0661 — Composite tenant foreign keys: surveys and knowledge base
-- =============================================================================
-- Surveys, feedback and the knowledge base.
--
-- 78 composite tenant foreign keys.
-- Requires 0656, which authors the unique keys these reference.
--
-- Series 0656-0664. Part of one change: 458 composite tenant foreign keys and
-- the 165 unique keys they reference existed only on the shared Neon branch,
-- created by hand and authored by no migration. backend/CLAUDE.md §3 requires
-- them and says application predicates and RLS do not replace them, so on a
-- database rebuilt from migrations/ nothing stopped a child row referencing a
-- parent in another organisation.
--
-- Shape rules, all of them load-bearing:
--
--   * Every definition is taken verbatim from pg_get_constraintdef, so the
--     ON DELETE clauses that nine of them carry survive. The only edits are
--     mechanical: a trailing " NOT VALID" is stripped from the four that are
--     live-but-unvalidated (we append our own), and the REFERENCES target is
--     schema-qualified — see the next point.
--
--   * Every table name is schema-qualified in all three positions: the
--     to_regclass probe, the ALTER TABLE, and the REFERENCES target. 123 of
--     these constraints are outside public (120 build, 3 build_events), and
--     to_regclass('public.x') on a build table returns NULL — the guard would
--     conclude the table does not exist, skip, and never create the constraint
--     on a fresh build. That is the guard's protection inverted, producing
--     exactly the defect this series exists to fix. The same trap bites the
--     REFERENCES clause from the other side: this database's search_path is
--     '"$user", public, build_events, app', so pg_get_constraintdef renders
--     build_events.ticket_comments as a bare "ticket_comments", which resolves
--     to the wrong table (or to nothing) under any other search_path.
--
--   * ADD CONSTRAINT ... NOT VALID first, VALIDATE CONSTRAINT as a separate
--     statement. A one-step ADD takes ACCESS EXCLUSIVE on BOTH tables while it
--     installs the triggers, so it stalls every write to both behind any long
--     read.
--
--   * Both halves are guarded on pg_constraint via to_regclass — never
--     ::regclass, which throws on a missing table. All of these already exist
--     on the database this was written against, so each file must be a no-op
--     there and the creating statement anywhere else.
--
--   * lock_timeout so a blocked ALTER fails fast instead of queueing and
--     blocking the table behind it.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assessment_attempts_assessment_id_org'
                     AND conrelid = to_regclass('public.assessment_attempts')) THEN
    ALTER TABLE "public"."assessment_attempts" ADD CONSTRAINT "fk_assessment_attempts_assessment_id_org" FOREIGN KEY (org_id, assessment_id) REFERENCES "public"."skill_assessments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assessment_attempts_assessment_id_org'
             AND conrelid = to_regclass('public.assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."assessment_attempts" VALIDATE CONSTRAINT "fk_assessment_attempts_assessment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.competencies') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_competencies_framework_id_org'
                     AND conrelid = to_regclass('public.competencies')) THEN
    ALTER TABLE "public"."competencies" ADD CONSTRAINT "fk_competencies_framework_id_org" FOREIGN KEY (org_id, framework_id) REFERENCES "public"."competency_frameworks"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_competencies_framework_id_org'
             AND conrelid = to_regclass('public.competencies') AND NOT convalidated) THEN
    ALTER TABLE "public"."competencies" VALIDATE CONSTRAINT "fk_competencies_framework_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.csat_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_survey_id_org'
                     AND conrelid = to_regclass('public.csat_responses')) THEN
    ALTER TABLE "public"."csat_responses" ADD CONSTRAINT "fk_csat_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."csat_surveys"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_survey_id_org'
             AND conrelid = to_regclass('public.csat_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."csat_responses" VALIDATE CONSTRAINT "fk_csat_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.feedback_cycle_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_cycle_requests_cycle_id_org'
                     AND conrelid = to_regclass('public.feedback_cycle_requests')) THEN
    ALTER TABLE "public"."feedback_cycle_requests" ADD CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."feedback_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_cycle_requests_cycle_id_org'
             AND conrelid = to_regclass('public.feedback_cycle_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."feedback_cycle_requests" VALIDATE CONSTRAINT "fk_feedback_cycle_requests_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.feedback_requests') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_requests_cycle_id_org'
                     AND conrelid = to_regclass('public.feedback_requests')) THEN
    ALTER TABLE "public"."feedback_requests" ADD CONSTRAINT "fk_feedback_requests_cycle_id_org" FOREIGN KEY (org_id, cycle_id) REFERENCES "public"."review_cycles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_feedback_requests_cycle_id_org'
             AND conrelid = to_regclass('public.feedback_requests') AND NOT convalidated) THEN
    ALTER TABLE "public"."feedback_requests" VALIDATE CONSTRAINT "fk_feedback_requests_cycle_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.nps_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_client_account_id_org'
                     AND conrelid = to_regclass('public.nps_responses')) THEN
    ALTER TABLE "public"."nps_responses" ADD CONSTRAINT "fk_nps_responses_client_account_id_org" FOREIGN KEY (org_id, client_account_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_client_account_id_org'
             AND conrelid = to_regclass('public.nps_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."nps_responses" VALIDATE CONSTRAINT "fk_nps_responses_client_account_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.nps_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_survey_id_org'
                     AND conrelid = to_regclass('public.nps_responses')) THEN
    ALTER TABLE "public"."nps_responses" ADD CONSTRAINT "fk_nps_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."nps_surveys"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_nps_responses_survey_id_org'
             AND conrelid = to_regclass('public.nps_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."nps_responses" VALIDATE CONSTRAINT "fk_nps_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_question_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_question_id_org" FOREIGN KEY (org_id, question_id) REFERENCES "public"."survey_questions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_question_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_session_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES "public"."survey_response_sessions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_session_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_survey_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_survey_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_answers') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_version_id_org'
                     AND conrelid = to_regclass('public.survey_answers')) THEN
    ALTER TABLE "public"."survey_answers" ADD CONSTRAINT "fk_survey_answers_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_answers_version_id_org'
             AND conrelid = to_regclass('public.survey_answers') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_answers" VALIDATE CONSTRAINT "fk_survey_answers_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_participant_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES "public"."survey_participants"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_participant_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_session_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES "public"."survey_response_sessions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_session_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_survey_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_survey_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_assessment_attempts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_version_id_org'
                     AND conrelid = to_regclass('public.survey_assessment_attempts')) THEN
    ALTER TABLE "public"."survey_assessment_attempts" ADD CONSTRAINT "fk_survey_assessment_attempts_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_assessment_attempts_version_id_org'
             AND conrelid = to_regclass('public.survey_assessment_attempts') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_assessment_attempts" VALIDATE CONSTRAINT "fk_survey_assessment_attempts_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_automation_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_session_id_org'
                     AND conrelid = to_regclass('public.survey_automation_events')) THEN
    ALTER TABLE "public"."survey_automation_events" ADD CONSTRAINT "fk_survey_automation_events_session_id_org" FOREIGN KEY (org_id, session_id) REFERENCES "public"."survey_response_sessions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_session_id_org'
             AND conrelid = to_regclass('public.survey_automation_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_automation_events" VALIDATE CONSTRAINT "fk_survey_automation_events_session_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_automation_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_survey_id_org'
                     AND conrelid = to_regclass('public.survey_automation_events')) THEN
    ALTER TABLE "public"."survey_automation_events" ADD CONSTRAINT "fk_survey_automation_events_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_automation_events_survey_id_org'
             AND conrelid = to_regclass('public.survey_automation_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_automation_events" VALIDATE CONSTRAINT "fk_survey_automation_events_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_attempt_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_attempt_id_org" FOREIGN KEY (org_id, attempt_id) REFERENCES "public"."survey_assessment_attempts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_attempt_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_attempt_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_participant_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES "public"."survey_participants"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_participant_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_certificates') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_survey_id_org'
                     AND conrelid = to_regclass('public.survey_certificates')) THEN
    ALTER TABLE "public"."survey_certificates" ADD CONSTRAINT "fk_survey_certificates_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_certificates_survey_id_org'
             AND conrelid = to_regclass('public.survey_certificates') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_certificates" VALIDATE CONSTRAINT "fk_survey_certificates_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_collectors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_survey_id_org'
                     AND conrelid = to_regclass('public.survey_collectors')) THEN
    ALTER TABLE "public"."survey_collectors" ADD CONSTRAINT "fk_survey_collectors_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_survey_id_org'
             AND conrelid = to_regclass('public.survey_collectors') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_collectors" VALIDATE CONSTRAINT "fk_survey_collectors_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_collectors') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_version_id_org'
                     AND conrelid = to_regclass('public.survey_collectors')) THEN
    ALTER TABLE "public"."survey_collectors" ADD CONSTRAINT "fk_survey_collectors_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_collectors_version_id_org'
             AND conrelid = to_regclass('public.survey_collectors') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_collectors" VALIDATE CONSTRAINT "fk_survey_collectors_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_current_question_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_current_question_id_org" FOREIGN KEY (org_id, current_question_id) REFERENCES "public"."survey_questions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_current_question_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_current_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_survey_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_live_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_version_id_org'
                     AND conrelid = to_regclass('public.survey_live_sessions')) THEN
    ALTER TABLE "public"."survey_live_sessions" ADD CONSTRAINT "fk_survey_live_sessions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_live_sessions_version_id_org'
             AND conrelid = to_regclass('public.survey_live_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_live_sessions" VALIDATE CONSTRAINT "fk_survey_live_sessions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_source_question_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_source_question_id_org" FOREIGN KEY (org_id, source_question_id) REFERENCES "public"."survey_questions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_source_question_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_source_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_survey_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_survey_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_logic_rules') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_version_id_org'
                     AND conrelid = to_regclass('public.survey_logic_rules')) THEN
    ALTER TABLE "public"."survey_logic_rules" ADD CONSTRAINT "fk_survey_logic_rules_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_logic_rules_version_id_org'
             AND conrelid = to_regclass('public.survey_logic_rules') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_logic_rules" VALIDATE CONSTRAINT "fk_survey_logic_rules_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_client_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_client_id_org" FOREIGN KEY (org_id, client_id) REFERENCES "public"."client_accounts"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_client_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_client_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_collector_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_collector_id_org" FOREIGN KEY (org_id, collector_id) REFERENCES "public"."survey_collectors"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_collector_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_collector_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_participants') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_survey_id_org'
                     AND conrelid = to_regclass('public.survey_participants')) THEN
    ALTER TABLE "public"."survey_participants" ADD CONSTRAINT "fk_survey_participants_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_participants_survey_id_org'
             AND conrelid = to_regclass('public.survey_participants') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_participants" VALIDATE CONSTRAINT "fk_survey_participants_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_question_choices') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_question_choices_question_id_org'
                     AND conrelid = to_regclass('public.survey_question_choices')) THEN
    ALTER TABLE "public"."survey_question_choices" ADD CONSTRAINT "fk_survey_question_choices_question_id_org" FOREIGN KEY (org_id, question_id) REFERENCES "public"."survey_questions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_question_choices_question_id_org'
             AND conrelid = to_regclass('public.survey_question_choices') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_question_choices" VALIDATE CONSTRAINT "fk_survey_question_choices_question_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_section_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_section_id_org" FOREIGN KEY (org_id, section_id) REFERENCES "public"."survey_sections"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_section_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_section_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_survey_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_questions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_version_id_org'
                     AND conrelid = to_regclass('public.survey_questions')) THEN
    ALTER TABLE "public"."survey_questions" ADD CONSTRAINT "fk_survey_questions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_questions_version_id_org'
             AND conrelid = to_regclass('public.survey_questions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_questions" VALIDATE CONSTRAINT "fk_survey_questions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_collector_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_collector_id_org" FOREIGN KEY (org_id, collector_id) REFERENCES "public"."survey_collectors"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_collector_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_collector_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_participant_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_participant_id_org" FOREIGN KEY (org_id, participant_id) REFERENCES "public"."survey_participants"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_participant_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_participant_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_survey_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_response_sessions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_version_id_org'
                     AND conrelid = to_regclass('public.survey_response_sessions')) THEN
    ALTER TABLE "public"."survey_response_sessions" ADD CONSTRAINT "fk_survey_response_sessions_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_response_sessions_version_id_org'
             AND conrelid = to_regclass('public.survey_response_sessions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_response_sessions" VALIDATE CONSTRAINT "fk_survey_response_sessions_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_responses') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_responses_survey_id_org'
                     AND conrelid = to_regclass('public.survey_responses')) THEN
    ALTER TABLE "public"."survey_responses" ADD CONSTRAINT "fk_survey_responses_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."pulse_surveys"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_responses_survey_id_org'
             AND conrelid = to_regclass('public.survey_responses') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_responses" VALIDATE CONSTRAINT "fk_survey_responses_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_sections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_survey_id_org'
                     AND conrelid = to_regclass('public.survey_sections')) THEN
    ALTER TABLE "public"."survey_sections" ADD CONSTRAINT "fk_survey_sections_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_survey_id_org'
             AND conrelid = to_regclass('public.survey_sections') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_sections" VALIDATE CONSTRAINT "fk_survey_sections_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_sections') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_version_id_org'
                     AND conrelid = to_regclass('public.survey_sections')) THEN
    ALTER TABLE "public"."survey_sections" ADD CONSTRAINT "fk_survey_sections_version_id_org" FOREIGN KEY (org_id, version_id) REFERENCES "public"."survey_versions"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_sections_version_id_org'
             AND conrelid = to_regclass('public.survey_sections') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_sections" VALIDATE CONSTRAINT "fk_survey_sections_version_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.survey_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_versions_survey_id_org'
                     AND conrelid = to_regclass('public.survey_versions')) THEN
    ALTER TABLE "public"."survey_versions" ADD CONSTRAINT "fk_survey_versions_survey_id_org" FOREIGN KEY (org_id, survey_id) REFERENCES "public"."survey_forms"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_survey_versions_survey_id_org'
             AND conrelid = to_regclass('public.survey_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."survey_versions" VALIDATE CONSTRAINT "fk_survey_versions_survey_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.announcement_reads') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_reads_announcement_id_org'
                     AND conrelid = to_regclass('public.announcement_reads')) THEN
    ALTER TABLE "public"."announcement_reads" ADD CONSTRAINT "fk_announcement_reads_announcement_id_org" FOREIGN KEY (org_id, announcement_id) REFERENCES "public"."announcements"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_reads_announcement_id_org'
             AND conrelid = to_regclass('public.announcement_reads') AND NOT convalidated) THEN
    ALTER TABLE "public"."announcement_reads" VALIDATE CONSTRAINT "fk_announcement_reads_announcement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.announcement_targets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_targets_announcement_id_org'
                     AND conrelid = to_regclass('public.announcement_targets')) THEN
    ALTER TABLE "public"."announcement_targets" ADD CONSTRAINT "fk_announcement_targets_announcement_id_org" FOREIGN KEY (org_id, announcement_id) REFERENCES "public"."announcements"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_announcement_targets_announcement_id_org'
             AND conrelid = to_regclass('public.announcement_targets') AND NOT convalidated) THEN
    ALTER TABLE "public"."announcement_targets" VALIDATE CONSTRAINT "fk_announcement_targets_announcement_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_attachments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_attachments')) THEN
    ALTER TABLE "public"."kb_article_attachments" ADD CONSTRAINT "fk_kb_article_attachments_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_attachments_article_id_org'
             AND conrelid = to_regclass('public.kb_article_attachments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_attachments" VALIDATE CONSTRAINT "fk_kb_article_attachments_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_article_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_attachment_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_attachment_id_org" FOREIGN KEY (org_id, attachment_id) REFERENCES "public"."kb_article_attachments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_attachment_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_attachment_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_page_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_page_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_chunks') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_source_id_org'
                     AND conrelid = to_regclass('public.kb_article_chunks')) THEN
    ALTER TABLE "public"."kb_article_chunks" ADD CONSTRAINT "fk_kb_article_chunks_source_id_org" FOREIGN KEY (org_id, source_id) REFERENCES "public"."kb_sources"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_chunks_source_id_org'
             AND conrelid = to_regclass('public.kb_article_chunks') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_chunks" VALIDATE CONSTRAINT "fk_kb_article_chunks_source_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_comments_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_comments')) THEN
    ALTER TABLE "public"."kb_article_comments" ADD CONSTRAINT "fk_kb_article_comments_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_comments_article_id_org'
             AND conrelid = to_regclass('public.kb_article_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_comments" VALIDATE CONSTRAINT "fk_kb_article_comments_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_feedback') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_feedback')) THEN
    ALTER TABLE "public"."kb_article_feedback" ADD CONSTRAINT "fk_kb_article_feedback_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_feedback_article_id_org'
             AND conrelid = to_regclass('public.kb_article_feedback') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_feedback" VALIDATE CONSTRAINT "fk_kb_article_feedback_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_restrictions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_restrictions')) THEN
    ALTER TABLE "public"."kb_article_restrictions" ADD CONSTRAINT "fk_kb_article_restrictions_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_restrictions_article_id_org'
             AND conrelid = to_regclass('public.kb_article_restrictions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_restrictions" VALIDATE CONSTRAINT "fk_kb_article_restrictions_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_article_id_org'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_article'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_org_article" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_article'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_org_article";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_tag'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_org_tag" FOREIGN KEY (org_id, tag_id) REFERENCES "public"."kb_tags"(org_id, id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_org_tag'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_org_tag";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_tags') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_tag_id_org'
                     AND conrelid = to_regclass('public.kb_article_tags')) THEN
    ALTER TABLE "public"."kb_article_tags" ADD CONSTRAINT "fk_kb_article_tags_tag_id_org" FOREIGN KEY (org_id, tag_id) REFERENCES "public"."kb_tags"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_tags_tag_id_org'
             AND conrelid = to_regclass('public.kb_article_tags') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_tags" VALIDATE CONSTRAINT "fk_kb_article_tags_tag_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_translations') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_translations')) THEN
    ALTER TABLE "public"."kb_article_translations" ADD CONSTRAINT "fk_kb_article_translations_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_translations_article_id_org'
             AND conrelid = to_regclass('public.kb_article_translations') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_translations" VALIDATE CONSTRAINT "fk_kb_article_translations_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_article_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_article_id_org'
                     AND conrelid = to_regclass('public.kb_article_versions')) THEN
    ALTER TABLE "public"."kb_article_versions" ADD CONSTRAINT "fk_kb_article_versions_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_article_versions_article_id_org'
             AND conrelid = to_regclass('public.kb_article_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_article_versions" VALIDATE CONSTRAINT "fk_kb_article_versions_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_category_id_org'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_category_id_org" FOREIGN KEY (org_id, category_id) REFERENCES "public"."kb_categories"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_category_id_org'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_category_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_articles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_space_id_org'
                     AND conrelid = to_regclass('public.kb_articles')) THEN
    ALTER TABLE "public"."kb_articles" ADD CONSTRAINT "fk_kb_articles_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES "public"."kb_spaces"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_articles_space_id_org'
             AND conrelid = to_regclass('public.kb_articles') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_articles" VALIDATE CONSTRAINT "fk_kb_articles_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_parent_id_org'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES "public"."kb_categories"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_parent_id_org'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_categories') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_space_id_org'
                     AND conrelid = to_regclass('public.kb_categories')) THEN
    ALTER TABLE "public"."kb_categories" ADD CONSTRAINT "fk_kb_categories_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES "public"."kb_spaces"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_categories_space_id_org'
             AND conrelid = to_regclass('public.kb_categories') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_categories" VALIDATE CONSTRAINT "fk_kb_categories_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_chat_messages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_conversation_id_org'
                     AND conrelid = to_regclass('public.kb_chat_messages')) THEN
    ALTER TABLE "public"."kb_chat_messages" ADD CONSTRAINT "fk_kb_chat_messages_conversation_id_org" FOREIGN KEY (org_id, conversation_id) REFERENCES "public"."kb_chat_conversations"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_chat_messages_conversation_id_org'
             AND conrelid = to_regclass('public.kb_chat_messages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_chat_messages" VALIDATE CONSTRAINT "fk_kb_chat_messages_conversation_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_events') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_article_id_org'
                     AND conrelid = to_regclass('public.kb_events')) THEN
    ALTER TABLE "public"."kb_events" ADD CONSTRAINT "fk_kb_events_article_id_org" FOREIGN KEY (org_id, article_id) REFERENCES "public"."kb_articles"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_events_article_id_org'
             AND conrelid = to_regclass('public.kb_events') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_events" VALIDATE CONSTRAINT "fk_kb_events_article_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_page_id_org'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_comments') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_parent_id_org'
                     AND conrelid = to_regclass('public.kb_page_comments')) THEN
    ALTER TABLE "public"."kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_parent_id_org" FOREIGN KEY (org_id, parent_id) REFERENCES "public"."kb_page_comments"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_parent_id_org'
             AND conrelid = to_regclass('public.kb_page_comments') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_comments" VALIDATE CONSTRAINT "fk_kb_page_comments_parent_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_favorites') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_favorites')) THEN
    ALTER TABLE "public"."kb_page_favorites" ADD CONSTRAINT "fk_kb_page_favorites_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_favorites_page_id_org'
             AND conrelid = to_regclass('public.kb_page_favorites') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_favorites" VALIDATE CONSTRAINT "fk_kb_page_favorites_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_links') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_source_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_links')) THEN
    ALTER TABLE "public"."kb_page_links" ADD CONSTRAINT "fk_kb_page_links_source_page_id_org" FOREIGN KEY (org_id, source_page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_links_source_page_id_org'
             AND conrelid = to_regclass('public.kb_page_links') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_links" VALIDATE CONSTRAINT "fk_kb_page_links_source_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_reviews') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_reviews')) THEN
    ALTER TABLE "public"."kb_page_reviews" ADD CONSTRAINT "fk_kb_page_reviews_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_reviews_page_id_org'
             AND conrelid = to_regclass('public.kb_page_reviews') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_reviews" VALIDATE CONSTRAINT "fk_kb_page_reviews_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_versions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_versions')) THEN
    ALTER TABLE "public"."kb_page_versions" ADD CONSTRAINT "fk_kb_page_versions_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_versions_page_id_org'
             AND conrelid = to_regclass('public.kb_page_versions') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_versions" VALIDATE CONSTRAINT "fk_kb_page_versions_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_page_visits') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_page_id_org'
                     AND conrelid = to_regclass('public.kb_page_visits')) THEN
    ALTER TABLE "public"."kb_page_visits" ADD CONSTRAINT "fk_kb_page_visits_page_id_org" FOREIGN KEY (org_id, page_id) REFERENCES "public"."kb_pages"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_visits_page_id_org'
             AND conrelid = to_regclass('public.kb_page_visits') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_page_visits" VALIDATE CONSTRAINT "fk_kb_page_visits_page_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_created_membership'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_created_membership" FOREIGN KEY (org_id, created_by_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_created_membership'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_created_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_owner_membership'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_org_owner_membership" FOREIGN KEY (org_id, owner_membership_id) REFERENCES "public"."organization_members"(org_id, id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_org_owner_membership'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_org_owner_membership";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_project_id_org'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_project_id_org" FOREIGN KEY (org_id, project_id) REFERENCES "build"."projects"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_project_id_org'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_project_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_pages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_space_id_org'
                     AND conrelid = to_regclass('public.kb_pages')) THEN
    ALTER TABLE "public"."kb_pages" ADD CONSTRAINT "fk_kb_pages_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES "public"."kb_spaces"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_pages_space_id_org'
             AND conrelid = to_regclass('public.kb_pages') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_pages" VALIDATE CONSTRAINT "fk_kb_pages_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_sources') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_space_id_org'
                     AND conrelid = to_regclass('public.kb_sources')) THEN
    ALTER TABLE "public"."kb_sources" ADD CONSTRAINT "fk_kb_sources_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES "public"."kb_spaces"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_sources_space_id_org'
             AND conrelid = to_regclass('public.kb_sources') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_sources" VALIDATE CONSTRAINT "fk_kb_sources_space_id_org";
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF to_regclass('public.kb_space_members') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_space_id_org'
                     AND conrelid = to_regclass('public.kb_space_members')) THEN
    ALTER TABLE "public"."kb_space_members" ADD CONSTRAINT "fk_kb_space_members_space_id_org" FOREIGN KEY (org_id, space_id) REFERENCES "public"."kb_spaces"(org_id, id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_space_members_space_id_org'
             AND conrelid = to_regclass('public.kb_space_members') AND NOT convalidated) THEN
    ALTER TABLE "public"."kb_space_members" VALIDATE CONSTRAINT "fk_kb_space_members_space_id_org";
  END IF;
END $$;

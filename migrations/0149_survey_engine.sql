-- Standalone Surveys product: general survey/assessment/live-session/lead-qualification
-- engine (surveys/13_Data_Model_And_Database.md). Additive only — does not touch
-- csat_surveys, nps_surveys, pulse_surveys/survey_responses, or skill_assessments/
-- assessment_attempts (HR performance.ts). Those keep working; this is a new engine
-- built alongside them, per the PRD's phased migration plan.
-- Hand-authored and applied directly via psql (see 0147_onboarding_flow_tables.sql /
-- MIGRATION.md for why: drizzle-kit push bundles unrelated pre-existing schema drift).
-- Questions/answers/choices/logic are normalized rows, not JSON blobs, per the PRD's
-- explicit non-negotiable (unlike pulse_surveys.questions / skill_assessments.questions).

BEGIN;

CREATE TYPE "survey_form_mode" AS ENUM ('survey', 'assessment', 'live_session', 'lead_qualification', 'custom');
CREATE TYPE "survey_form_status" AS ENUM ('draft', 'testing', 'published', 'paused', 'closed', 'archived');
CREATE TYPE "survey_question_type" AS ENUM (
  'short_text', 'long_text', 'single_select', 'multi_select', 'dropdown', 'rating',
  'star_rating', 'nps', 'number', 'email', 'phone', 'date', 'matrix', 'likert',
  'ranking', 'slider', 'yes_no', 'consent', 'content_block'
);
CREATE TYPE "survey_collector_type" AS ENUM (
  'public_link', 'email', 'qr', 'embed', 'popup', 'crm_campaign', 'hr_audience',
  'support_trigger', 'live_session', 'manual_access_code'
);
CREATE TYPE "survey_collector_status" AS ENUM ('active', 'paused', 'closed', 'expired');
CREATE TYPE "survey_participant_status" AS ENUM (
  'invited', 'delivered', 'opened', 'started', 'partial', 'completed', 'disqualified',
  'bounced', 'unsubscribed', 'expired'
);
CREATE TYPE "survey_response_session_status" AS ENUM ('in_progress', 'submitted', 'invalid', 'excluded', 'deleted_by_policy');
CREATE TYPE "survey_assessment_attempt_status" AS ENUM ('not_started', 'in_progress', 'submitted', 'passed', 'failed', 'expired');
CREATE TYPE "survey_live_session_status" AS ENUM ('draft', 'waiting', 'active', 'paused', 'ended');
CREATE TYPE "survey_automation_event_status" AS ENUM ('pending', 'processed', 'failed', 'skipped');

CREATE TABLE "survey_forms" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "mode" "survey_form_mode" NOT NULL DEFAULT 'survey',
  "status" "survey_form_status" NOT NULL DEFAULT 'draft',
  "owner_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "default_language" text NOT NULL DEFAULT 'en',
  "active_version_id" integer,
  "settings" jsonb DEFAULT '{}'::jsonb,
  "branding" jsonb DEFAULT '{}'::jsonb,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "archived_at" timestamp
);
CREATE INDEX "idx_survey_forms_org_status_mode" ON "survey_forms" ("org_id", "status", "mode");

CREATE TABLE "survey_versions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_number" integer NOT NULL,
  "schema_snapshot" jsonb,
  "published_at" timestamp,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_versions_survey_number" UNIQUE ("survey_id", "version_number")
);
CREATE INDEX "idx_survey_versions_survey" ON "survey_versions" ("survey_id");

ALTER TABLE "survey_forms"
  ADD CONSTRAINT "fk_survey_forms_active_version"
  FOREIGN KEY ("active_version_id") REFERENCES "survey_versions"("id") ON DELETE SET NULL;

CREATE TABLE "survey_sections" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "settings" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_survey_sections_version" ON "survey_sections" ("survey_id", "version_id", "sort_order");

CREATE TABLE "survey_questions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "section_id" integer NOT NULL REFERENCES "survey_sections"("id") ON DELETE CASCADE,
  "question_key" text NOT NULL,
  "variable_name" text,
  "type" "survey_question_type" NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "required" boolean NOT NULL DEFAULT false,
  "settings" jsonb DEFAULT '{}'::jsonb,
  "validation" jsonb DEFAULT '{}'::jsonb,
  "scoring" jsonb DEFAULT '{}'::jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_questions_version_key" UNIQUE ("version_id", "question_key")
);
CREATE INDEX "idx_survey_questions_section" ON "survey_questions" ("survey_id", "version_id", "section_id", "sort_order");

CREATE TABLE "survey_question_choices" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "question_id" integer NOT NULL REFERENCES "survey_questions"("id") ON DELETE CASCADE,
  "choice_key" text NOT NULL,
  "label" text NOT NULL,
  "value" text,
  "score" integer DEFAULT 0,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_correct" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_question_choices_question_key" UNIQUE ("question_id", "choice_key")
);
CREATE INDEX "idx_survey_question_choices_question" ON "survey_question_choices" ("question_id", "sort_order");

CREATE TABLE "survey_logic_rules" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "source_question_id" integer NOT NULL REFERENCES "survey_questions"("id") ON DELETE CASCADE,
  "condition" jsonb NOT NULL,
  "action" jsonb NOT NULL,
  "target" jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_survey_logic_rules_source" ON "survey_logic_rules" ("survey_id", "version_id", "source_question_id");

CREATE TABLE "survey_collectors" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer REFERENCES "survey_versions"("id") ON DELETE SET NULL,
  "collector_type" "survey_collector_type" NOT NULL,
  "name" text NOT NULL,
  "token" text NOT NULL,
  "status" "survey_collector_status" NOT NULL DEFAULT 'active',
  "source" text,
  "utm" jsonb DEFAULT '{}'::jsonb,
  "settings" jsonb DEFAULT '{}'::jsonb,
  "opens" integer NOT NULL DEFAULT 0,
  "starts" integer NOT NULL DEFAULT 0,
  "completions" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_collectors_token" UNIQUE ("token")
);
CREATE INDEX "idx_survey_collectors_survey_status" ON "survey_collectors" ("survey_id", "status");

CREATE TABLE "survey_participants" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "collector_id" integer REFERENCES "survey_collectors"("id") ON DELETE SET NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "contact_id" integer REFERENCES "contacts"("id") ON DELETE SET NULL,
  "lead_id" integer REFERENCES "leads"("id") ON DELETE SET NULL,
  "client_id" integer REFERENCES "client_accounts"("id") ON DELETE SET NULL,
  "name" text,
  "email" text,
  "phone" text,
  "status" "survey_participant_status" NOT NULL DEFAULT 'invited',
  "access_token_hash" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "invited_at" timestamp,
  "opened_at" timestamp,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_participants_access_token_hash" UNIQUE ("access_token_hash")
);
CREATE INDEX "idx_survey_participants_org_survey_status" ON "survey_participants" ("org_id", "survey_id", "status");

CREATE TABLE "survey_response_sessions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "collector_id" integer REFERENCES "survey_collectors"("id") ON DELETE SET NULL,
  "participant_id" integer REFERENCES "survey_participants"("id") ON DELETE SET NULL,
  "status" "survey_response_session_status" NOT NULL DEFAULT 'in_progress',
  "anonymous" boolean NOT NULL DEFAULT false,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "submitted_at" timestamp,
  "duration_seconds" integer,
  "score" integer,
  "passed" boolean,
  "segment" text,
  "metadata" jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX "idx_survey_response_sessions_survey_submitted" ON "survey_response_sessions" ("org_id", "survey_id", "submitted_at");
CREATE INDEX "idx_survey_response_sessions_collector" ON "survey_response_sessions" ("collector_id");

CREATE TABLE "survey_answers" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "survey_response_sessions"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "question_id" integer NOT NULL REFERENCES "survey_questions"("id") ON DELETE CASCADE,
  "answer_value" jsonb,
  "answer_text" text,
  "choice_ids" jsonb,
  "score" integer,
  "answered_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "idx_survey_answers_org_question" ON "survey_answers" ("org_id", "question_id");
CREATE INDEX "idx_survey_answers_session" ON "survey_answers" ("session_id");

CREATE TABLE "survey_assessment_attempts" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "participant_id" integer REFERENCES "survey_participants"("id") ON DELETE SET NULL,
  "session_id" integer REFERENCES "survey_response_sessions"("id") ON DELETE SET NULL,
  "attempt_number" integer NOT NULL DEFAULT 1,
  "status" "survey_assessment_attempt_status" NOT NULL DEFAULT 'not_started',
  "score" integer,
  "passed" boolean,
  "started_at" timestamp,
  "submitted_at" timestamp,
  "expires_at" timestamp
);
CREATE INDEX "idx_survey_assessment_attempts_survey_participant" ON "survey_assessment_attempts" ("survey_id", "participant_id");

CREATE TABLE "survey_certificates" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "participant_id" integer NOT NULL REFERENCES "survey_participants"("id") ON DELETE CASCADE,
  "attempt_id" integer NOT NULL REFERENCES "survey_assessment_attempts"("id") ON DELETE CASCADE,
  "certificate_number" text NOT NULL,
  "issued_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp,
  "file_url" text,
  CONSTRAINT "uq_survey_certificates_number" UNIQUE ("certificate_number")
);
CREATE INDEX "idx_survey_certificates_survey_participant" ON "survey_certificates" ("survey_id", "participant_id");

CREATE TABLE "survey_live_sessions" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "version_id" integer NOT NULL REFERENCES "survey_versions"("id") ON DELETE CASCADE,
  "host_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "session_code" text NOT NULL,
  "status" "survey_live_session_status" NOT NULL DEFAULT 'draft',
  "current_question_id" integer REFERENCES "survey_questions"("id") ON DELETE SET NULL,
  "started_at" timestamp,
  "ended_at" timestamp,
  "settings" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "uq_survey_live_sessions_code" UNIQUE ("session_code")
);
CREATE INDEX "idx_survey_live_sessions_survey" ON "survey_live_sessions" ("survey_id");

CREATE TABLE "survey_automation_events" (
  "id" serial PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "survey_id" integer NOT NULL REFERENCES "survey_forms"("id") ON DELETE CASCADE,
  "session_id" integer REFERENCES "survey_response_sessions"("id") ON DELETE SET NULL,
  "event_type" text NOT NULL,
  "status" "survey_automation_event_status" NOT NULL DEFAULT 'pending',
  "payload" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "processed_at" timestamp
);
CREATE INDEX "idx_survey_automation_events_org_survey_type" ON "survey_automation_events" ("org_id", "survey_id", "event_type");

COMMIT;

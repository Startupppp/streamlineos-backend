-- ============================================================================
-- drizzle-sync-recruitment.sql
-- ============================================================================
-- Purpose: Sync the live Neon DB to the Drizzle schema for recruitment/hiring
--          tables + columns that are MISSING and causing 500 errors.
--
-- SAFETY: ADDITIVE ONLY. This script contains NO DROP TABLE, NO DROP COLUMN,
--         NO destructive type changes, and NO data loss. Every statement is
--         IDEMPOTENT (IF NOT EXISTS / guarded), so it is safe to run repeatedly.
--         No NOT NULL column is added to an existing/populated table without a
--         DEFAULT.
--
-- Source of truth: src/db/schema/hr/hiring.ts and src/db/schema/hr/documents.ts
-- Verified against information_schema on the live DB before authoring.
--
-- ----------------------------------------------------------------------------
-- CREATES (14 tables, all confirmed MISSING in live DB):
--   hiring_flows, hiring_flow_rounds, recruitment_vendors,
--   vendor_candidate_submissions, headcount_requests, offer_letter_templates,
--   candidate_messages, email_sequences, email_sequence_steps,
--   email_sequence_enrollments, scheduled_reports, job_recruiters,
--   recruiter_activity_log, pipeline_automations
--
-- ADDS COLUMNS (to existing tables):
--   job_postings        -> hiring_flow_id, is_internal
--   candidate_offers    -> approved_by, approved_at, approval_remarks,
--                          acceptance_token, acceptance_token_expires_at
--   candidate_applications -> tracking_token
--   candidate_referrals -> job_posting_id, status, updated_at  (shape drift;
--                          old referred_by/bonus_* columns are left untouched)
--   learning_paths      -> level, estimated_hours
--
-- ENUMS CREATED: none. The new tables use plain text columns (Drizzle $type<>
--   string unions, not pgEnum). All pgEnums referenced by touched tables
--   (job_posting_status, application_status, etc.) already exist.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) NEW TABLES
--    Ordered so FK dependencies are created before dependents.
-- ============================================================================

-- ---- hiring_flows ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS hiring_flows (
  id          serial PRIMARY KEY,
  org_id      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_by  text NOT NULL REFERENCES users(id),
  created_at  timestamp NOT NULL DEFAULT now(),
  updated_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hiring_flows_org ON hiring_flows (org_id);

-- ---- hiring_flow_rounds ----------------------------------------------------
CREATE TABLE IF NOT EXISTS hiring_flow_rounds (
  id                           serial PRIMARY KEY,
  flow_id                      integer NOT NULL REFERENCES hiring_flows(id) ON DELETE CASCADE,
  org_id                       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                         text NOT NULL,
  round_type                   text NOT NULL DEFAULT 'CUSTOM',
  mode                         text NOT NULL DEFAULT 'VIDEO',
  duration_minutes             integer NOT NULL DEFAULT 60,
  sla_days                     integer,
  question_bank_tag            text,
  scorecard_template_id        integer REFERENCES scorecard_templates(id),
  interviewer_role_restriction text,
  auto_advance_threshold       integer,
  order_index                  integer NOT NULL DEFAULT 0,
  created_at                   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hiring_flow_rounds_flow ON hiring_flow_rounds (flow_id);

-- ---- recruitment_vendors ---------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_vendors (
  id            serial PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  contact_name  text,
  contact_email text,
  contact_phone text,
  website       text,
  fee_percent   numeric(5,2),
  status        text NOT NULL DEFAULT 'ACTIVE',
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamp NOT NULL DEFAULT now(),
  updated_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recruitment_vendors_org ON recruitment_vendors (org_id);

-- ---- vendor_candidate_submissions ------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_candidate_submissions (
  id               serial PRIMARY KEY,
  vendor_id        integer NOT NULL REFERENCES recruitment_vendors(id) ON DELETE CASCADE,
  candidate_id     integer NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  job_posting_id   integer REFERENCES job_postings(id) ON DELETE SET NULL,
  submitted_at     timestamp NOT NULL DEFAULT now(),
  placement_status text NOT NULL DEFAULT 'SUBMITTED',
  invoice_status   text NOT NULL DEFAULT 'NOT_INVOICED',
  invoice_amount   numeric(15,2),
  invoice_date     date,
  paid_at          date,
  created_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_submissions_vendor ON vendor_candidate_submissions (vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_submissions_candidate ON vendor_candidate_submissions (candidate_id);

-- ---- headcount_requests ----------------------------------------------------
CREATE TABLE IF NOT EXISTS headcount_requests (
  id                    serial PRIMARY KEY,
  org_id                text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id         integer REFERENCES departments(id),
  requested_by          text NOT NULL REFERENCES users(id),
  requested_role        text NOT NULL,
  level                 text,
  justification         text,
  target_date           date,
  status                text NOT NULL DEFAULT 'DRAFT',
  approved_by           text REFERENCES users(id),
  approved_at           timestamp,
  rejected_reason       text,
  linked_job_posting_id integer REFERENCES job_postings(id) ON DELETE SET NULL,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_headcount_requests_org ON headcount_requests (org_id);
CREATE INDEX IF NOT EXISTS idx_headcount_requests_status ON headcount_requests (status);
CREATE INDEX IF NOT EXISTS idx_headcount_requests_dept ON headcount_requests (department_id);

-- ---- offer_letter_templates ------------------------------------------------
CREATE TABLE IF NOT EXISTS offer_letter_templates (
  id           serial PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  html_content text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_by   text NOT NULL REFERENCES users(id),
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offer_letter_templates_org ON offer_letter_templates (org_id);

-- ---- candidate_messages ----------------------------------------------------
CREATE TABLE IF NOT EXISTS candidate_messages (
  id           serial PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  candidate_id integer NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  direction    text NOT NULL DEFAULT 'OUTBOUND',
  channel      text NOT NULL DEFAULT 'EMAIL',
  subject      text,
  body         text NOT NULL,
  sent_by      text REFERENCES users(id),
  sent_at      timestamp NOT NULL DEFAULT now(),
  read_at      timestamp,
  external_id  text,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_candidate_messages_org ON candidate_messages (org_id);
CREATE INDEX IF NOT EXISTS idx_candidate_messages_candidate ON candidate_messages (candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_messages_sent ON candidate_messages (sent_at);

-- ---- email_sequences -------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sequences (
  id              serial PRIMARY KEY,
  org_id          text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  is_active       boolean NOT NULL DEFAULT true,
  trigger_type    text NOT NULL DEFAULT 'MANUAL',
  target_audience jsonb DEFAULT '{}'::jsonb,
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_sequences_org ON email_sequences (org_id);

-- ---- email_sequence_steps --------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sequence_steps (
  id          serial PRIMARY KEY,
  sequence_id integer NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  step_order  integer NOT NULL,
  delay_days  integer NOT NULL DEFAULT 0,
  subject     text NOT NULL,
  html_body   text NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_sequence_steps_sequence ON email_sequence_steps (sequence_id);

-- ---- email_sequence_enrollments --------------------------------------------
CREATE TABLE IF NOT EXISTS email_sequence_enrollments (
  id           serial PRIMARY KEY,
  sequence_id  integer NOT NULL REFERENCES email_sequences(id) ON DELETE CASCADE,
  candidate_id integer NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  current_step integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'ACTIVE',
  enrolled_at  timestamp NOT NULL DEFAULT now(),
  next_send_at timestamp,
  completed_at timestamp
);
CREATE INDEX IF NOT EXISTS idx_email_sequence_enrollments_sequence ON email_sequence_enrollments (sequence_id);
CREATE INDEX IF NOT EXISTS idx_email_sequence_enrollments_candidate ON email_sequence_enrollments (candidate_id);
CREATE INDEX IF NOT EXISTS idx_email_sequence_enrollments_next_send ON email_sequence_enrollments (next_send_at);

-- ---- scheduled_reports -----------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id            serial PRIMARY KEY,
  org_id        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  report_config jsonb NOT NULL,
  schedule      text NOT NULL,
  recipients    text[] NOT NULL DEFAULT '{}'::text[],
  last_run_at   timestamp,
  created_by    text NOT NULL REFERENCES users(id),
  created_at    timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org ON scheduled_reports (org_id);

-- ---- job_recruiters --------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_recruiters (
  id             serial PRIMARY KEY,
  job_posting_id integer NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by    text NOT NULL REFERENCES users(id),
  assigned_at    timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_recruiters_job_user ON job_recruiters (job_posting_id, user_id);
CREATE INDEX IF NOT EXISTS idx_job_recruiters_job ON job_recruiters (job_posting_id);
CREATE INDEX IF NOT EXISTS idx_job_recruiters_user ON job_recruiters (user_id);

-- ---- recruiter_activity_log ------------------------------------------------
CREATE TABLE IF NOT EXISTS recruiter_activity_log (
  id             serial PRIMARY KEY,
  org_id         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recruiter_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action         text NOT NULL,
  candidate_id   integer REFERENCES candidates(id) ON DELETE SET NULL,
  job_posting_id integer REFERENCES job_postings(id) ON DELETE SET NULL,
  notes          text,
  created_at     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recruiter_activity_org ON recruiter_activity_log (org_id);
CREATE INDEX IF NOT EXISTS idx_recruiter_activity_recruiter ON recruiter_activity_log (recruiter_id);
CREATE INDEX IF NOT EXISTS idx_recruiter_activity_created ON recruiter_activity_log (created_at);

-- ---- pipeline_automations --------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_automations (
  id                 serial PRIMARY KEY,
  org_id             text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  trigger            text NOT NULL,
  trigger_conditions jsonb DEFAULT '{}'::jsonb,
  action             text NOT NULL,
  action_payload     jsonb DEFAULT '{}'::jsonb,
  created_by         text NOT NULL REFERENCES users(id),
  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_automations_org ON pipeline_automations (org_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_automations_trigger ON pipeline_automations (trigger);

-- ============================================================================
-- 2) NEW COLUMNS ON EXISTING TABLES (additive, all defaulted where NOT NULL)
-- ============================================================================

-- ---- job_postings ----------------------------------------------------------
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS hiring_flow_id integer REFERENCES hiring_flows(id);
ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

-- ---- candidate_offers (approval workflow + acceptance token) ----------------
ALTER TABLE candidate_offers ADD COLUMN IF NOT EXISTS approved_by text REFERENCES users(id);
ALTER TABLE candidate_offers ADD COLUMN IF NOT EXISTS approved_at timestamp;
ALTER TABLE candidate_offers ADD COLUMN IF NOT EXISTS approval_remarks text;
ALTER TABLE candidate_offers ADD COLUMN IF NOT EXISTS acceptance_token text;
ALTER TABLE candidate_offers ADD COLUMN IF NOT EXISTS acceptance_token_expires_at timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS candidate_offers_acceptance_token_unique ON candidate_offers (acceptance_token);

-- ---- candidate_applications -------------------------------------------------
ALTER TABLE candidate_applications ADD COLUMN IF NOT EXISTS tracking_token text;
CREATE UNIQUE INDEX IF NOT EXISTS candidate_applications_tracking_token_unique ON candidate_applications (tracking_token);

-- ---- candidate_referrals (shape drift: ADD-only, never drop referred_by/bonus_*)
ALTER TABLE candidate_referrals ADD COLUMN IF NOT EXISTS job_posting_id integer REFERENCES job_postings(id);
ALTER TABLE candidate_referrals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'SUBMITTED';
ALTER TABLE candidate_referrals ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_referrals_org ON candidate_referrals (org_id);
CREATE INDEX IF NOT EXISTS idx_referrals_candidate ON candidate_referrals (candidate_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_by ON candidate_referrals (referred_by);

-- ---- learning_paths --------------------------------------------------------
ALTER TABLE learning_paths ADD COLUMN IF NOT EXISTS level text;
ALTER TABLE learning_paths ADD COLUMN IF NOT EXISTS estimated_hours integer;

COMMIT;

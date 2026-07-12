-- SignOS core schema: documents, envelopes, recipients, fields, templates,
-- signature assets, audit trail, certificates, bulk send, public forms, org settings.

DO $$ BEGIN
  CREATE TYPE sign_envelope_status AS ENUM ('draft', 'ready_to_send', 'sent', 'delivered', 'partially_completed', 'completed', 'declined', 'voided', 'expired', 'correction_required', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_routing_mode AS ENUM ('parallel', 'sequential', 'mixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_cc_timing AS ENUM ('on_send', 'on_complete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_recipient_status AS ENUM ('pending', 'invited', 'viewed', 'authenticated', 'signing', 'completed', 'declined', 'delegated', 'bounced', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_recipient_type AS ENUM ('signer', 'approver', 'cc', 'viewer', 'in_person_host', 'internal_reviewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_auth_method AS ENUM ('email_link', 'access_code', 'otp_email', 'otp_sms', 'sso', 'passkey', 'kba', 'id_verification');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_conversion_status AS ENUM ('pending', 'converted', 'failed', 'not_needed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_field_type AS ENUM ('signature', 'initials', 'date_signed', 'text', 'multiline', 'email', 'name', 'company', 'title', 'checkbox', 'radio', 'dropdown', 'attachment', 'stamp', 'strikethrough', 'readonly_merge');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_template_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_signature_asset_type AS ENUM ('signature', 'initials', 'stamp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_signature_method AS ENUM ('drawn', 'typed', 'uploaded', 'saved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_actor_type AS ENUM ('internal_user', 'external_signer', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_audit_event_type AS ENUM (
    'envelope_created', 'envelope_updated', 'document_uploaded', 'recipient_added', 'recipient_updated',
    'recipient_removed', 'field_added', 'field_updated', 'field_deleted', 'envelope_validated', 'envelope_sent',
    'email_delivered', 'email_bounced', 'reminder_sent', 'signing_link_opened', 'authentication_passed',
    'authentication_failed', 'consent_accepted', 'document_viewed', 'field_completed', 'signature_adopted',
    'recipient_completed', 'recipient_declined', 'recipient_delegated', 'envelope_corrected', 'envelope_voided',
    'envelope_expired', 'envelope_extended', 'envelope_completed', 'final_pdf_generated', 'certificate_generated',
    'certificate_regenerated', 'document_downloaded', 'template_created', 'template_published', 'template_archived',
    'bulk_job_created', 'bulk_job_completed', 'bulk_job_cancelled', 'public_form_published', 'public_form_submitted',
    'admin_setting_changed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_bulk_job_status AS ENUM ('pending', 'validating', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_bulk_row_status AS ENUM ('pending', 'success', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_watermark_scope AS ENUM ('tenant', 'template', 'envelope');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sign_public_form_status AS ENUM ('draft', 'published', 'unpublished');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- sign_templates
CREATE TABLE IF NOT EXISTS sign_templates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  category text,
  status sign_template_status NOT NULL DEFAULT 'draft',
  owner_user_id text REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  template_json jsonb NOT NULL DEFAULT '{}',
  restricted_to_roles jsonb NOT NULL DEFAULT '[]',
  restricted_to_teams jsonb NOT NULL DEFAULT '[]',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_templates_org_status ON sign_templates(org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_templates_org_name_version ON sign_templates(org_id, name, version);

-- sign_watermark_policies
CREATE TABLE IF NOT EXISTS sign_watermark_policies (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type sign_watermark_scope NOT NULL DEFAULT 'tenant',
  scope_id integer,
  applies_states jsonb NOT NULL DEFAULT '[]',
  text text,
  image_file_key text,
  opacity integer NOT NULL DEFAULT 30,
  angle integer NOT NULL DEFAULT 45,
  color text NOT NULL DEFAULT '#94A3B8',
  font_size integer NOT NULL DEFAULT 36,
  placement text NOT NULL DEFAULT 'diagonal_tiled',
  pages jsonb NOT NULL DEFAULT '{"mode":"all"}',
  show_on_final_pdf boolean NOT NULL DEFAULT true,
  preview_only boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_watermark_policies_org_scope ON sign_watermark_policies(org_id, scope_type, scope_id);

-- sign_public_forms (depends only on templates, created before envelopes so envelopes can FK it)
CREATE TABLE IF NOT EXISTS sign_public_forms (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id integer NOT NULL REFERENCES sign_templates(id) ON DELETE CASCADE,
  slug text NOT NULL,
  status sign_public_form_status NOT NULL DEFAULT 'draft',
  access_code_hash text,
  max_submissions integer,
  submission_count integer NOT NULL DEFAULT 0,
  expires_at timestamp,
  completion_redirect_url text,
  webhook_url text,
  embed_allowed boolean NOT NULL DEFAULT false,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_public_forms_slug ON sign_public_forms(slug);
CREATE INDEX IF NOT EXISTS idx_sign_public_forms_org_status ON sign_public_forms(org_id, status);

-- sign_envelopes
CREATE TABLE IF NOT EXISTS sign_envelopes (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  subject text,
  message text,
  status sign_envelope_status NOT NULL DEFAULT 'draft',
  routing_mode sign_routing_mode NOT NULL DEFAULT 'parallel',
  cc_timing sign_cc_timing NOT NULL DEFAULT 'on_complete',
  allow_decline boolean NOT NULL DEFAULT true,
  source_module text,
  source_entity_type text,
  source_entity_id text,
  template_id integer REFERENCES sign_templates(id) ON DELETE SET NULL,
  watermark_policy_id integer REFERENCES sign_watermark_policies(id) ON DELETE SET NULL,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  reminder_enabled boolean NOT NULL DEFAULT true,
  reminder_first_after_days integer NOT NULL DEFAULT 3,
  reminder_repeat_days integer NOT NULL DEFAULT 3,
  reminder_max_count integer NOT NULL DEFAULT 5,
  reminder_sent_count integer NOT NULL DEFAULT 0,
  last_reminder_at timestamp,
  expires_at timestamp,
  sent_at timestamp,
  completed_at timestamp,
  voided_at timestamp,
  voided_by text REFERENCES users(id) ON DELETE SET NULL,
  void_reason text,
  declined_at timestamp,
  correction_required_at timestamp,
  correction_reason text,
  finalization_key text,
  finalized_at timestamp,
  final_pdf_file_key text,
  final_pdf_hash text,
  public_form_id integer REFERENCES sign_public_forms(id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_envelopes_org_status ON sign_envelopes(org_id, status);
CREATE INDEX IF NOT EXISTS idx_sign_envelopes_org_sender ON sign_envelopes(org_id, sender_user_id);
CREATE INDEX IF NOT EXISTS idx_sign_envelopes_source ON sign_envelopes(source_module, source_entity_type, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_sign_envelopes_expires ON sign_envelopes(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_envelopes_finalization_key ON sign_envelopes(finalization_key);

-- sign_documents
CREATE TABLE IF NOT EXISTS sign_documents (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  original_file_key text NOT NULL,
  current_file_key text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  page_count integer,
  file_size integer NOT NULL,
  sha256_hash text NOT NULL,
  conversion_status sign_conversion_status NOT NULL DEFAULT 'not_needed',
  conversion_error text,
  order_index integer NOT NULL DEFAULT 0,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_documents_org_envelope ON sign_documents(org_id, envelope_id);

-- sign_recipients
CREATE TABLE IF NOT EXISTS sign_recipients (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  role_name text NOT NULL,
  recipient_type sign_recipient_type NOT NULL DEFAULT 'signer',
  name text NOT NULL,
  email text,
  phone text,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  routing_order integer NOT NULL DEFAULT 1,
  status sign_recipient_status NOT NULL DEFAULT 'pending',
  auth_method sign_auth_method NOT NULL DEFAULT 'email_link',
  access_code_hash text,
  otp_code_hash text,
  otp_expires_at timestamp,
  otp_attempts integer NOT NULL DEFAULT 0,
  failed_auth_attempts integer NOT NULL DEFAULT 0,
  auth_locked_until timestamp,
  signing_token_hash text,
  token_expires_at timestamp,
  token_revoked_at timestamp,
  consent_accepted_at timestamp,
  consent_ip text,
  consent_user_agent text,
  consent_disclosure_version text,
  delegated_to_recipient_id integer REFERENCES sign_recipients(id) ON DELETE SET NULL,
  viewed_at timestamp,
  authenticated_at timestamp,
  completed_at timestamp,
  declined_at timestamp,
  declined_reason text,
  bounced_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_recipients_org_envelope ON sign_recipients(org_id, envelope_id);
CREATE INDEX IF NOT EXISTS idx_sign_recipients_envelope_order ON sign_recipients(envelope_id, routing_order);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_recipients_token_hash ON sign_recipients(signing_token_hash);

-- sign_fields
CREATE TABLE IF NOT EXISTS sign_fields (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  document_id integer NOT NULL REFERENCES sign_documents(id) ON DELETE CASCADE,
  recipient_id integer NOT NULL REFERENCES sign_recipients(id) ON DELETE CASCADE,
  field_type sign_field_type NOT NULL,
  label text,
  page_number integer NOT NULL,
  x integer NOT NULL,
  y integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  required boolean NOT NULL DEFAULT false,
  readonly boolean NOT NULL DEFAULT false,
  order_index integer NOT NULL DEFAULT 0,
  group_id text,
  default_value text,
  options_json jsonb,
  validation_type text,
  validation_rules_json jsonb,
  conditional_rules_json jsonb,
  value_json jsonb,
  attachment_file_key text,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_fields_org_envelope ON sign_fields(org_id, envelope_id);
CREATE INDEX IF NOT EXISTS idx_sign_fields_document ON sign_fields(document_id);
CREATE INDEX IF NOT EXISTS idx_sign_fields_recipient ON sign_fields(recipient_id);

-- sign_signature_assets
CREATE TABLE IF NOT EXISTS sign_signature_assets (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  recipient_id integer NOT NULL REFERENCES sign_recipients(id) ON DELETE CASCADE,
  asset_type sign_signature_asset_type NOT NULL,
  method sign_signature_method NOT NULL,
  image_file_key text,
  typed_text text,
  typed_font_style text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_signature_assets_recipient ON sign_signature_assets(recipient_id);
CREATE INDEX IF NOT EXISTS idx_sign_signature_assets_org_envelope ON sign_signature_assets(org_id, envelope_id);

-- sign_audit_events (append-only)
CREATE TABLE IF NOT EXISTS sign_audit_events (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  recipient_id integer REFERENCES sign_recipients(id) ON DELETE SET NULL,
  actor_type sign_actor_type NOT NULL,
  actor_user_id text,
  actor_name text,
  actor_email text,
  event_type sign_audit_event_type NOT NULL,
  event_message text,
  ip_address text,
  user_agent text,
  geolocation_json jsonb,
  document_hash text,
  request_id text,
  event_payload_json jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_audit_events_org_envelope_created ON sign_audit_events(org_id, envelope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sign_audit_events_recipient ON sign_audit_events(recipient_id);
CREATE INDEX IF NOT EXISTS idx_sign_audit_events_type ON sign_audit_events(event_type);

-- sign_certificates (immutable)
CREATE TABLE IF NOT EXISTS sign_certificates (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope_id integer NOT NULL REFERENCES sign_envelopes(id) ON DELETE CASCADE,
  certificate_number text NOT NULL,
  certificate_file_key text NOT NULL,
  final_pdf_file_key text NOT NULL,
  final_pdf_hash text NOT NULL,
  watermarked boolean NOT NULL DEFAULT false,
  generated_at timestamp NOT NULL DEFAULT now(),
  certificate_json jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_certificates_number ON sign_certificates(certificate_number);
CREATE INDEX IF NOT EXISTS idx_sign_certificates_org_envelope ON sign_certificates(org_id, envelope_id);

-- sign_bulk_send_jobs
CREATE TABLE IF NOT EXISTS sign_bulk_send_jobs (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id integer NOT NULL REFERENCES sign_templates(id) ON DELETE CASCADE,
  sender_user_id text NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  status sign_bulk_job_status NOT NULL DEFAULT 'pending',
  column_mapping_json jsonb NOT NULL DEFAULT '{}',
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  csv_file_key text,
  error_report_file_key text,
  created_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_sign_bulk_send_jobs_org_status ON sign_bulk_send_jobs(org_id, status);

-- sign_bulk_send_rows
CREATE TABLE IF NOT EXISTS sign_bulk_send_rows (
  id serial PRIMARY KEY,
  job_id integer NOT NULL REFERENCES sign_bulk_send_jobs(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw_data_json jsonb NOT NULL,
  status sign_bulk_row_status NOT NULL DEFAULT 'pending',
  envelope_id integer REFERENCES sign_envelopes(id) ON DELETE SET NULL,
  error_message text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sign_bulk_send_rows_job ON sign_bulk_send_rows(job_id, row_number);
CREATE INDEX IF NOT EXISTS idx_sign_bulk_send_rows_status ON sign_bulk_send_rows(job_id, status);

-- sign_org_settings
CREATE TABLE IF NOT EXISTS sign_org_settings (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  default_expiration_days integer NOT NULL DEFAULT 30,
  expiration_warning_days integer NOT NULL DEFAULT 3,
  default_reminder_first_after_days integer NOT NULL DEFAULT 3,
  default_reminder_repeat_days integer NOT NULL DEFAULT 3,
  default_reminder_max_count integer NOT NULL DEFAULT 5,
  allowed_file_types jsonb NOT NULL DEFAULT '["application/pdf"]',
  max_file_size_mb integer NOT NULL DEFAULT 25,
  allowed_auth_methods jsonb NOT NULL DEFAULT '["email_link","access_code","otp_email"]',
  certificate_format text NOT NULL DEFAULT 'pdf',
  retention_policy_json jsonb NOT NULL DEFAULT '{}',
  public_forms_enabled boolean NOT NULL DEFAULT true,
  bulk_send_max_rows_per_job integer NOT NULL DEFAULT 500,
  bulk_send_max_active_jobs integer NOT NULL DEFAULT 5,
  bulk_send_max_recipients_per_envelope integer NOT NULL DEFAULT 20,
  sender_rate_limit_per_hour integer NOT NULL DEFAULT 200,
  branding_json jsonb NOT NULL DEFAULT '{}',
  webhook_url text,
  webhook_secret text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_sign_org_settings_org ON sign_org_settings(org_id);

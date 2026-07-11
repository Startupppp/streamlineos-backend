-- Migration 0225: HR Enterprise Ops (Packs 11-15)
-- Idempotent — uses IF NOT EXISTS / CREATE TYPE … DO $$ … END $$

DO $$ BEGIN
  CREATE TYPE hr_accommodation_type AS ENUM ('equipment','schedule','workspace','medical_restriction','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_accommodation_status AS ENUM ('requested','under_review','approved','denied','implemented');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_accommodation_task_status AS ENUM ('pending','in_progress','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_emergency_event_type AS ENUM ('office_closure','disaster','safety_check','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_emergency_event_status AS ENUM ('active','resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_emergency_response_status AS ENUM ('safe','need_help','no_response');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_access_provisioning_action AS ENUM ('grant','revoke','review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_access_provisioning_status AS ENUM ('pending','completed','verified','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_access_provisioning_trigger AS ENUM ('joiner','mover','leaver','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_simulation_type AS ENUM ('policy','leave','attendance','approval','payroll');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "hr_accommodation_requests" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "user_id"                 text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "type"                    hr_accommodation_type NOT NULL,
  "description"             text NOT NULL,
  "confidential_medical_note" text,
  "status"                  hr_accommodation_status NOT NULL DEFAULT 'requested',
  "reviewed_by"             text REFERENCES users(id) ON DELETE SET NULL,
  "review_date"             date,
  "note"                    text,
  "created_at"              timestamp NOT NULL DEFAULT now(),
  "updated_at"              timestamp NOT NULL DEFAULT now(),
  "deleted_at"              timestamp
);

CREATE INDEX IF NOT EXISTS idx_hr_acc_req_org  ON hr_accommodation_requests(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_acc_req_user ON hr_accommodation_requests(user_id);

CREATE TABLE IF NOT EXISTS "hr_accommodation_tasks" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"           text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "request_id"       uuid NOT NULL REFERENCES hr_accommodation_requests(id) ON DELETE CASCADE,
  "title"            text NOT NULL,
  "assignee_user_id" text REFERENCES users(id) ON DELETE SET NULL,
  "status"           hr_accommodation_task_status NOT NULL DEFAULT 'pending',
  "due_date"         date,
  "created_at"       timestamp NOT NULL DEFAULT now(),
  "updated_at"       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_acc_task_org     ON hr_accommodation_tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_acc_task_request ON hr_accommodation_tasks(request_id);

CREATE TABLE IF NOT EXISTS "hr_emergency_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"      text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name"        text NOT NULL,
  "type"        hr_emergency_event_type NOT NULL,
  "location_id" text,
  "status"      hr_emergency_event_status NOT NULL DEFAULT 'active',
  "message"     text NOT NULL,
  "created_by"  text NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  "created_at"  timestamp NOT NULL DEFAULT now(),
  "updated_at"  timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp
);

CREATE INDEX IF NOT EXISTS idx_hr_emerg_ev_org    ON hr_emergency_events(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_emerg_ev_status ON hr_emergency_events(org_id, status);

CREATE TABLE IF NOT EXISTS "hr_emergency_responses" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "event_id"     uuid NOT NULL REFERENCES hr_emergency_events(id) ON DELETE CASCADE,
  "user_id"      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "status"       hr_emergency_response_status NOT NULL DEFAULT 'no_response',
  "responded_at" timestamp,
  "note"         text,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_emerg_resp_event ON hr_emergency_responses(event_id);
CREATE INDEX IF NOT EXISTS idx_hr_emerg_resp_user  ON hr_emergency_responses(org_id, user_id);

CREATE TABLE IF NOT EXISTS "hr_access_provisioning" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "user_id"       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "system_name"   text NOT NULL,
  "action"        hr_access_provisioning_action NOT NULL,
  "status"        hr_access_provisioning_status NOT NULL DEFAULT 'pending',
  "triggered_by"  hr_access_provisioning_trigger NOT NULL,
  "requested_at"  timestamp NOT NULL DEFAULT now(),
  "completed_at"  timestamp,
  "verified_by"   text REFERENCES users(id) ON DELETE SET NULL,
  "created_at"    timestamp NOT NULL DEFAULT now(),
  "updated_at"    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_org    ON hr_access_provisioning(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_user   ON hr_access_provisioning(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_status ON hr_access_provisioning(org_id, status);

CREATE TABLE IF NOT EXISTS "hr_access_provisioning_templates" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"         text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "name"           text NOT NULL,
  "triggered_by"   hr_access_provisioning_trigger NOT NULL,
  "systems_config" jsonb NOT NULL DEFAULT '[]',
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_tmpl_org ON hr_access_provisioning_templates(org_id);

CREATE TABLE IF NOT EXISTS "hr_simulations" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "type"       hr_simulation_type NOT NULL,
  "input"      jsonb NOT NULL DEFAULT '{}',
  "result"     jsonb NOT NULL DEFAULT '{}',
  "created_by" text NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_sim_org  ON hr_simulations(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_sim_type ON hr_simulations(org_id, type);

CREATE TABLE IF NOT EXISTS "hr_event_stream" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"        text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  "event_type"    text NOT NULL,
  "entity_type"   text NOT NULL,
  "entity_id"     text NOT NULL,
  "payload"       jsonb NOT NULL DEFAULT '{}',
  "actor_user_id" text REFERENCES users(id) ON DELETE SET NULL,
  "occurred_at"   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_evstream_org      ON hr_event_stream(org_id);
CREATE INDEX IF NOT EXISTS idx_hr_evstream_type     ON hr_event_stream(org_id, event_type);
CREATE INDEX IF NOT EXISTS idx_hr_evstream_entity   ON hr_event_stream(org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_hr_evstream_occurred ON hr_event_stream(org_id, occurred_at);

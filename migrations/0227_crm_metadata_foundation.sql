-- Migration 0227: CRM metadata foundation
-- Creates metadata-driven pipeline/stage/option/validation/blueprint tables
-- Converts 5 hardcoded lead/deal enum columns to text

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS crm_pipelines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'custom',
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_pipelines_org_key ON crm_pipelines (org_id, key);
CREATE INDEX IF NOT EXISTS idx_crm_pipelines_org ON crm_pipelines (org_id);

CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  probability INTEGER NOT NULL DEFAULT 0,
  stage_type TEXT NOT NULL DEFAULT 'open',
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  sla_hours INTEGER,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  required_fields JSONB,
  allowed_next_stage_keys JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_pipeline_stages_org_pipe_key ON crm_pipeline_stages (org_id, pipeline_id, key);
CREATE INDEX IF NOT EXISTS idx_crm_pipeline_stages_org_pipe_sort ON crm_pipeline_stages (org_id, pipeline_id, sort_order);

CREATE TABLE IF NOT EXISTS crm_options (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  color TEXT,
  icon TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_options_org_type_key ON crm_options (org_id, type, key);
CREATE INDEX IF NOT EXISTS idx_crm_options_org_type_active ON crm_options (org_id, type, is_active);

CREATE TABLE IF NOT EXISTS crm_validation_rules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  field TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  config JSONB,
  pipeline_id TEXT,
  stage_key TEXT,
  source_key TEXT,
  error_message TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_validation_rules_org_entity ON crm_validation_rules (org_id, entity_type, is_active);

CREATE TABLE IF NOT EXISTS crm_blueprints (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id TEXT NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_blueprints_org_pipeline ON crm_blueprints (org_id, pipeline_id);

CREATE TABLE IF NOT EXISTS crm_blueprint_transitions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  blueprint_id TEXT NOT NULL REFERENCES crm_blueprints(id) ON DELETE CASCADE,
  from_stage_key TEXT NOT NULL,
  to_stage_key TEXT NOT NULL,
  required_fields JSONB,
  required_activity_type_keys JSONB,
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  requires_quote BOOLEAN NOT NULL DEFAULT FALSE,
  auto_task_templates JSONB,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crm_blueprint_transitions_org_blueprint ON crm_blueprint_transitions (org_id, blueprint_id);

CREATE TABLE IF NOT EXISTS crm_stage_requirements (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES crm_pipeline_stages(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL,
  config JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_stage_requirements_org_stage ON crm_stage_requirements (org_id, stage_id);

CREATE TABLE IF NOT EXISTS crm_automation_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  entity_type TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_automation_events_org_key ON crm_automation_events (org_id, key);

CREATE TABLE IF NOT EXISTS crm_automation_actions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  config_schema JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_automation_actions_org_key ON crm_automation_actions (org_id, key);

CREATE TABLE IF NOT EXISTS crm_ui_metadata (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_ui_metadata_org_scope ON crm_ui_metadata (org_id, scope);

-- Convert leads.status from enum to text
ALTER TABLE leads ALTER COLUMN status DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN status TYPE TEXT USING status::TEXT;
ALTER TABLE leads ALTER COLUMN status SET DEFAULT 'NEW';
ALTER TABLE leads ALTER COLUMN status SET NOT NULL;

-- Convert leads.priority from enum to text
ALTER TABLE leads ALTER COLUMN priority DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN priority TYPE TEXT USING priority::TEXT;
ALTER TABLE leads ALTER COLUMN priority SET DEFAULT 'WARM';
ALTER TABLE leads ALTER COLUMN priority SET NOT NULL;

-- Convert leads.source from enum to text
ALTER TABLE leads ALTER COLUMN source DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN source TYPE TEXT USING source::TEXT;
ALTER TABLE leads ALTER COLUMN source SET DEFAULT 'other';
ALTER TABLE leads ALTER COLUMN source SET NOT NULL;

-- Convert lead_activities.type from enum to text
ALTER TABLE lead_activities ALTER COLUMN type TYPE TEXT USING type::TEXT;
ALTER TABLE lead_activities ALTER COLUMN type SET NOT NULL;

-- Convert deals.stage from enum to text
ALTER TABLE deals ALTER COLUMN stage DROP DEFAULT;
ALTER TABLE deals ALTER COLUMN stage TYPE TEXT USING stage::TEXT;
ALTER TABLE deals ALTER COLUMN stage SET DEFAULT 'LEAD';
ALTER TABLE deals ALTER COLUMN stage SET NOT NULL;

-- Drop the 5 retired enum types (only safe after all columns converted)
DROP TYPE IF EXISTS lead_pipeline_status;
DROP TYPE IF EXISTS lead_priority;
DROP TYPE IF EXISTS lead_source;
DROP TYPE IF EXISTS lead_activity_type;
DROP TYPE IF EXISTS deal_stage;

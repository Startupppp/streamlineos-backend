DO $$ BEGIN
  CREATE TYPE hr_automation_run_status AS ENUM ('success', 'partial', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS hr_automation_rules (
  id                SERIAL PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  trigger_event     TEXT NOT NULL,
  conditions        JSONB NOT NULL DEFAULT '[]',
  actions           JSONB NOT NULL DEFAULT '[]',
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  webhook_secret    TEXT,
  run_count         INTEGER NOT NULL DEFAULT 0,
  last_run_at       TIMESTAMPTZ,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_automation_rules_org_name
  ON hr_automation_rules (org_id, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_hr_automation_rules_org_event
  ON hr_automation_rules (org_id, trigger_event);

CREATE INDEX IF NOT EXISTS idx_hr_automation_rules_org_enabled
  ON hr_automation_rules (org_id, is_enabled);

CREATE TABLE IF NOT EXISTS hr_automation_runs (
  id                   SERIAL PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id              INTEGER NOT NULL REFERENCES hr_automation_rules(id) ON DELETE CASCADE,
  trigger_event        TEXT NOT NULL,
  event_payload        JSONB,
  status               hr_automation_run_status NOT NULL,
  action_results       JSONB,
  error                TEXT,
  duration_ms          INTEGER,
  triggered_by_run_id  INTEGER,
  depth                INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hr_automation_runs_org_rule_created
  ON hr_automation_runs (org_id, rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hr_automation_runs_org_status
  ON hr_automation_runs (org_id, status);

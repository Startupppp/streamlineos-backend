-- deals: add pipeline_id, forecast_category, next_step, health_score
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_id text REFERENCES crm_pipelines(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS forecast_category text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_step text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS health_score integer;

-- Index: org + pipeline + stage for board queries
CREATE INDEX IF NOT EXISTS idx_deals_org_pipeline_stage ON deals(org_id, pipeline_id, stage);

-- Backfill pipeline_id to each org's default deal pipeline
UPDATE deals
SET pipeline_id = (
  SELECT p.id
  FROM crm_pipelines p
  WHERE p.org_id = deals.org_id
    AND p.type = 'deal'
    AND p.is_default = true
  LIMIT 1
)
WHERE pipeline_id IS NULL;

-- deal_approval_rules: drop hardcoded CEO default, add approver_type + approver_user_id
ALTER TABLE deal_approval_rules ALTER COLUMN approver_role DROP DEFAULT;
ALTER TABLE deal_approval_rules ADD COLUMN IF NOT EXISTS approver_type text NOT NULL DEFAULT 'role';
ALTER TABLE deal_approval_rules ADD COLUMN IF NOT EXISTS approver_user_id text REFERENCES users(id) ON DELETE SET NULL;

-- crm_deal_competitors: new table
CREATE TABLE IF NOT EXISTS crm_deal_competitors (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id integer NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  competitor_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT uq_crm_deal_competitors_deal_key UNIQUE (org_id, deal_id, competitor_key)
);
CREATE INDEX IF NOT EXISTS idx_crm_deal_competitors_deal ON crm_deal_competitors(deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_competitors_org ON crm_deal_competitors(org_id);

-- crm_forecast_snapshots: new table
CREATE TABLE IF NOT EXISTS crm_forecast_snapshots (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  captured_at timestamp DEFAULT now() NOT NULL,
  created_by_id text REFERENCES users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_forecast_snapshots_org_period ON crm_forecast_snapshots(org_id, period, captured_at DESC);

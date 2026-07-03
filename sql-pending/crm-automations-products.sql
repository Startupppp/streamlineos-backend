-- CRM Automation Rules table
CREATE TABLE IF NOT EXISTS crm_automation_rules (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  conditions JSONB NOT NULL DEFAULT '[]',
  actions JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  execution_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_automation_rules_org
  ON crm_automation_rules(org_id, is_active, created_at);

CREATE INDEX IF NOT EXISTS idx_crm_automation_rules_deleted
  ON crm_automation_rules(deleted_at);

-- CRM Products table
CREATE TABLE IF NOT EXISTS crm_products (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  category TEXT,
  unit_price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  tax_rate INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_products_org
  ON crm_products(org_id, is_active, created_at);

CREATE INDEX IF NOT EXISTS idx_crm_products_deleted
  ON crm_products(deleted_at);

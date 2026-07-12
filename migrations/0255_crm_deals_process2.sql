CREATE TABLE IF NOT EXISTS crm_deal_stakeholders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role_key TEXT,
  influence TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_deal_stakeholders_deal_contact ON crm_deal_stakeholders (org_id, deal_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_stakeholders_deal ON crm_deal_stakeholders (org_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_deal_stakeholders_contact ON crm_deal_stakeholders (org_id, contact_id);

ALTER TABLE crm_forecast_snapshots
  ADD COLUMN IF NOT EXISTS override_amount NUMERIC(15, 4),
  ADD COLUMN IF NOT EXISTS override_note TEXT,
  ADD COLUMN IF NOT EXISTS overridden_by TEXT REFERENCES users(id) ON DELETE SET NULL;

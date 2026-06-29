-- Commission rules + earned commissions
CREATE TABLE IF NOT EXISTS commission_rules (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'flat_percent', -- flat_percent | tiered
  flat_rate DECIMAL, -- e.g. 2.5 means 2.5%
  tiers JSONB, -- [{ minValue: 0, maxValue: 500000, rate: 2 }, { minValue: 500001, rate: 3 }]
  applies_to TEXT NOT NULL DEFAULT 'all', -- all | stage (only specific deal stages)
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commissions (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  rule_id INTEGER REFERENCES commission_rules(id),
  deal_value DECIMAL NOT NULL DEFAULT '0',
  commission_rate DECIMAL NOT NULL DEFAULT '0',
  commission_amount DECIMAL NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | paid
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commissions_org_user ON commissions (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_commissions_deal ON commissions (deal_id);

-- Deal approval workflow
CREATE TABLE IF NOT EXISTS deal_approval_rules (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  min_value DECIMAL NOT NULL DEFAULT '0', -- deals above this value need approval
  approver_role TEXT NOT NULL DEFAULT 'CEO', -- which role can approve
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deal_approvals (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_stage TEXT NOT NULL, -- the stage being transitioned TO (usually WON)
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  approved_by TEXT REFERENCES users(id),
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deal_approvals_org ON deal_approvals (org_id, status);
CREATE INDEX IF NOT EXISTS idx_deal_approvals_deal ON deal_approvals (deal_id);

-- Client health scoring
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_score INTEGER DEFAULT 50;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_status TEXT DEFAULT 'healthy'; -- healthy | at_risk | critical
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS churn_risk_score INTEGER;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS churn_risk_reasoning TEXT;

-- Idempotent migration to ensure all schema columns exist in the DB.
-- Safe to run multiple times. Fixes gaps where earlier migrations may not have been applied.

-- ═══ LEADS TABLE ═══
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sub_source TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS dm_lead_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website TEXT;

-- ═══ DEALS TABLE ═══
ALTER TABLE deals ADD COLUMN IF NOT EXISTS follow_up_date TIMESTAMP;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS linked_lead_id INTEGER;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS linked_client_id INTEGER;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMP;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS probability INTEGER DEFAULT 0;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS expected_close_date DATE;

-- ═══ CLIENTS TABLE ═══ (health metrics)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_score INTEGER DEFAULT 50;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS health_status TEXT DEFAULT 'healthy';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMP;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS churn_risk_score INTEGER;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS churn_risk_reasoning TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS investment_value DECIMAL(15,2);

-- ═══ INDEXES ═══
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (org_id, follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_follow_up ON deals (org_id, follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_health ON clients (org_id, health_status);

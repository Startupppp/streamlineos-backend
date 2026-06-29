-- Partial indexes for common filtered queries (Neon-friendly, low write overhead)

-- Leads: overdue follow-ups
CREATE INDEX IF NOT EXISTS idx_leads_follow_up_overdue
  ON leads (org_id, follow_up_date) WHERE follow_up_date IS NOT NULL;

-- Deals: open pipeline (excludes WON/LOST)
CREATE INDEX IF NOT EXISTS idx_deals_open_pipeline
  ON deals (org_id, stage) WHERE stage NOT IN ('WON', 'LOST');

-- Clients: at-risk health status
CREATE INDEX IF NOT EXISTS idx_clients_at_risk
  ON clients (org_id, health_status) WHERE health_status IN ('at_risk', 'critical');

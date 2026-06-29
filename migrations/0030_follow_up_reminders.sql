-- Follow-up reminders on leads and deals
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_date TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS follow_up_date TIMESTAMP;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS follow_up_notes TEXT;

-- Index for finding overdue follow-ups efficiently
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (org_id, follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_follow_up ON deals (org_id, follow_up_date) WHERE follow_up_date IS NOT NULL;

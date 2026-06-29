-- Enhance crm_campaigns table with more fields for the campaign builder
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS target_audience TEXT;
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id);
ALTER TABLE crm_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

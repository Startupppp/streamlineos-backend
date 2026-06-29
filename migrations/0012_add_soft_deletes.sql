-- Soft delete columns for compliance / data recovery
-- Migration: 0012_add_soft_deletes

ALTER TABLE leads       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE deals       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE payrolls    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE invoices    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE clients     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE tickets     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
ALTER TABLE expenses    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Partial indexes to keep active-record queries fast
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_not_deleted
  ON leads (org_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_not_deleted
  ON deals (org_id, stage) WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_not_deleted
  ON tickets (project_id, status) WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_not_deleted
  ON expenses (org_id, status) WHERE deleted_at IS NULL;

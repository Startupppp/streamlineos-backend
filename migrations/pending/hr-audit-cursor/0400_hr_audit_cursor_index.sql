SET statement_timeout = '30min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_audit_logs_org_created_id
  ON hr_audit_logs (org_id, created_at, id);

SET statement_timeout = '30min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DROP INDEX CONCURRENTLY IF EXISTS idx_hr_audit_logs_org_created_id;

SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'hr_audit_logs'
      AND indexname = 'idx_hr_audit_logs_org_created_id'
      AND indexdef LIKE '%(org_id, created_at, id)%'
  ) THEN
    RAISE EXCEPTION 'HR_AUDIT_CURSOR_INDEX_MISSING_OR_INVALID';
  END IF;
END
$verify$;

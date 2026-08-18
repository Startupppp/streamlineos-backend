SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM hr_audit_logs
    WHERE org_id IS NULL OR created_at IS NULL OR id IS NULL
  ) THEN
    RAISE EXCEPTION 'HR_AUDIT_CURSOR_BACKFILL_REFUSED_NULL_KEY';
  END IF;
END
$backfill$;

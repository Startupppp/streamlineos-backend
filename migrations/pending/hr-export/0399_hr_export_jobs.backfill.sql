SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $backfill$
BEGIN
  IF to_regclass('public.hr_export_jobs') IS NULL THEN
    RAISE EXCEPTION 'HR_EXPORT_BACKFILL_REFUSED_TABLE_MISSING';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hr_export_jobs
    WHERE filters IS NULL
       OR requested_scope IS NULL
       OR requested_by IS NULL
       OR idempotency_key IS NULL
       OR request_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'HR_EXPORT_BACKFILL_REFUSED_INVALID_EXISTING_ROW';
  END IF;
END
$backfill$;

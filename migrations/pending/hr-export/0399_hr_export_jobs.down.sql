SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $rollback$
DECLARE
  existing_rows bigint;
BEGIN
  IF to_regclass('public.hr_export_jobs') IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO existing_rows FROM hr_export_jobs;
  IF existing_rows > 0 THEN
    RAISE EXCEPTION 'HR_EXPORT_ROLLBACK_REFUSED_NONEMPTY_TABLE row_count=%', existing_rows;
  END IF;
END
$rollback$;

DROP TABLE IF EXISTS hr_export_jobs RESTRICT;

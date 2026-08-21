SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $verify$
DECLARE
  actual_columns integer;
  expected_columns constant integer := 24;
BEGIN
  IF to_regclass('public.hr_export_jobs') IS NULL THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_TABLE_MISSING';
  END IF;

  SELECT count(*)
    INTO actual_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'hr_export_jobs';

  IF actual_columns <> expected_columns THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_COLUMN_COUNT expected %, got %', expected_columns, actual_columns;
  END IF;

  IF EXISTS (
    SELECT required.name
    FROM (
      VALUES
        ('hr_export_jobs_pkey'),
        ('hr_export_jobs_org_id_organizations_id_fk'),
        ('uniq_hr_export_jobs_org_id'),
        ('chk_hr_export_jobs_status'),
        ('chk_hr_export_jobs_scope'),
        ('chk_hr_export_jobs_entity'),
        ('chk_hr_export_jobs_attempts'),
        ('chk_hr_export_jobs_counts')
    ) AS required(name)
    LEFT JOIN pg_constraint constraint_catalog
      ON constraint_catalog.conname = required.name
     AND constraint_catalog.conrelid = 'public.hr_export_jobs'::regclass
    WHERE constraint_catalog.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_CONSTRAINT_MISSING';
  END IF;

  IF EXISTS (
    SELECT required.name
    FROM (
      VALUES
        ('uniq_hr_export_jobs_org_idempotency'),
        ('idx_hr_export_jobs_org_status_created'),
        ('idx_hr_export_jobs_org_requester_created')
    ) AS required(name)
    LEFT JOIN pg_indexes index_catalog
      ON index_catalog.schemaname = 'public'
     AND index_catalog.tablename = 'hr_export_jobs'
     AND index_catalog.indexname = required.name
    WHERE index_catalog.indexname IS NULL
  ) THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_INDEX_MISSING';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'public.hr_export_jobs'::regclass
      AND relrowsecurity
      AND relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_RLS_NOT_FORCED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'hr_export_jobs'
      AND policyname = 'tenant_isolation'
      AND cmd = 'ALL'
  ) THEN
    RAISE EXCEPTION 'HR_EXPORT_VERIFY_POLICY_MISSING';
  END IF;
END
$verify$;

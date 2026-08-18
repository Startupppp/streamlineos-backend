DO $$
DECLARE
  missing_contract_count integer;
BEGIN
  SELECT count(*)
  INTO missing_contract_count
  FROM (VALUES
    ('attendance', 'chk_attendance_status'),
    ('onboarding_template_steps', 'chk_onboarding_template_steps_owner_role'),
    ('onboarding_tasks', 'chk_onboarding_tasks_owner_role'),
    ('onboarding_tasks', 'chk_onboarding_tasks_status'),
    ('onboarding_documents', 'chk_onboarding_documents_version_positive'),
    ('leave_requests', 'chk_leave_requests_priority'),
    ('leave_requests', 'chk_leave_requests_half_day_period'),
    ('leave_blackout_dates', 'chk_leave_blackout_dates_applies_to'),
    ('resignations', 'chk_resignations_row_version'),
    ('terminations', 'chk_terminations_row_version')
  ) AS required_contract(table_name, constraint_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_catalog
    JOIN pg_class relation_catalog ON relation_catalog.oid = constraint_catalog.conrelid
    JOIN pg_namespace schema_catalog ON schema_catalog.oid = relation_catalog.relnamespace
    WHERE schema_catalog.nspname = 'public'
      AND relation_catalog.relname = required_contract.table_name
      AND constraint_catalog.conname = required_contract.constraint_name
      AND constraint_catalog.convalidated
  );

  IF missing_contract_count <> 0 THEN
    RAISE EXCEPTION 'HRMS_LIFECYCLE_CONSTRAINT_VERIFICATION_FAILED';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_catalog
    JOIN pg_class index_relation ON index_relation.oid = index_catalog.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_catalog.indrelid
    JOIN pg_namespace schema_catalog ON schema_catalog.oid = table_relation.relnamespace
    WHERE schema_catalog.nspname = 'public'
      AND table_relation.relname = 'onboarding_documents'
      AND index_relation.relname = 'uniq_onboarding_documents_org_user_type_version'
      AND index_catalog.indisunique
      AND index_catalog.indisvalid
  ) THEN
    RAISE EXCEPTION 'HRMS_ONBOARDING_DOCUMENT_VERSION_INDEX_MISSING';
  END IF;

  IF (
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('resignations', 'terminations')
      AND column_name = 'row_version'
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('resignations', 'terminations')
      AND column_name = 'row_version'
      AND (is_nullable <> 'NO' OR column_default IS NULL)
  ) THEN
    RAISE EXCEPTION 'HRMS_LIFECYCLE_ROW_VERSION_COLUMN_INVALID';
  END IF;
END
$$;

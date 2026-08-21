SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $ledger_preflight$
DECLARE
  target_operation_id text := nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '');
  target_bundle_id text := nullif(btrim(current_setting('app.hrms_bundle_id', true)), '');
  target_file_name text := nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '');
  target_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '');
  target_manifest_hash text := nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '');
  target_root_hash text := nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '');
  matched_rows integer;
BEGIN
  IF target_operation_id IS NULL OR target_bundle_id IS NULL OR target_file_name IS NULL
    OR target_sql_hash IS NULL OR target_manifest_hash IS NULL OR target_root_hash IS NULL THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_METADATA_MISSING' USING ERRCODE = '22023';
  END IF;
  IF target_file_name <> '0002_hrms_leave_ledger.sql' THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('app.hrms_sql_bundle_operations') IS NULL THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_LEDGER_MISSING' USING ERRCODE = '42P01';
  END IF;
  PERFORM 1
  FROM app.hrms_sql_bundle_operations operation
  WHERE operation.operation_id = target_operation_id
    AND operation.bundle_id = target_bundle_id
    AND operation.file_name = target_file_name
    AND operation.sql_hash = target_sql_hash
    AND operation.manifest_hash = target_manifest_hash
    AND operation.root_migration_hash = target_root_hash
    AND operation.database_name = current_database()
    AND operation.database_role = current_user
    AND operation.server_version_num = current_setting('server_version_num')::integer
    AND operation.state = 'COMPLETE'
  FOR UPDATE;
  GET DIAGNOSTICS matched_rows = ROW_COUNT;
  IF matched_rows <> 1 THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_COMPLETE_TARGET_INVALID' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.hrms_sql_bundle_operations operation
    WHERE operation.operation_id <> target_operation_id
      AND operation.file_name = target_file_name
      AND operation.database_name = current_database()
      AND operation.state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_COMPLETE_TARGET_AMBIGUOUS' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.hrms_sql_bundle_operations operation
    WHERE operation.database_name = current_database()
      AND operation.file_name IN (
        '0003_hrms_attendance_events.sql',
        '0004_hrms_hierarchy_audit.sql'
      )
      AND operation.state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_ACTIVE_LATER_DEPENDENCY' USING ERRCODE = '55000';
  END IF;
END
$ledger_preflight$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM worker_leave_entry_locators LIMIT 1)
    OR EXISTS (SELECT 1 FROM worker_leave_ledger_entries LIMIT 1)
    OR EXISTS (SELECT 1 FROM worker_leave_reversal_links LIMIT 1)
    OR EXISTS (SELECT 1 FROM worker_leave_balance_projections LIMIT 1) THEN
    RAISE EXCEPTION 'HRMS_ROLLBACK_REFUSED_POPULATED_LEAVE_FACTS'
      USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE worker_leave_balance_projections RESTRICT;
DROP TABLE worker_leave_reversal_links RESTRICT;
ALTER TABLE worker_leave_entry_locators
  DROP CONSTRAINT fk_worker_leave_locators_fact;
DROP TABLE worker_leave_ledger_entries RESTRICT;
DROP TABLE worker_leave_entry_locators RESTRICT;
DROP FUNCTION IF EXISTS app.verify_worker_leave_balance_projection();
DROP FUNCTION IF EXISTS app.verify_worker_leave_reversal();
DROP FUNCTION IF EXISTS app.verify_worker_leave_locator_fact();

DO $ledger_complete$
DECLARE
  matched_rows integer;
BEGIN
  UPDATE app.hrms_sql_bundle_operations operation
  SET state = 'ROLLED_BACK',
    completed_at = greatest(clock_timestamp(), operation.completed_at + interval '1 microsecond'),
    last_error = NULL
  WHERE operation.operation_id = btrim(current_setting('app.hrms_bundle_operation_id'))
    AND operation.bundle_id = btrim(current_setting('app.hrms_bundle_id'))
    AND operation.file_name = '0002_hrms_leave_ledger.sql'
    AND operation.sql_hash = btrim(current_setting('app.hrms_bundle_sql_hash'))
    AND operation.manifest_hash = btrim(current_setting('app.hrms_bundle_manifest_hash'))
    AND operation.root_migration_hash = btrim(current_setting('app.hrms_bundle_root_migration_hash'))
    AND operation.database_name = current_database()
    AND operation.database_role = current_user
    AND operation.server_version_num = current_setting('server_version_num')::integer
    AND operation.state = 'COMPLETE';
  GET DIAGNOSTICS matched_rows = ROW_COUNT;
  IF matched_rows <> 1 THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_MARK_FAILED' USING ERRCODE = '55000';
  END IF;
END
$ledger_complete$;

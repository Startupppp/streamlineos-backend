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
  IF target_file_name <> '0001_hrms_effective_history.sql' THEN
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
        '0002_hrms_leave_ledger.sql',
        '0003_hrms_attendance_events.sql',
        '0004_hrms_hierarchy_audit.sql'
      )
      AND operation.state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_ACTIVE_LATER_DEPENDENCY' USING ERRCODE = '55000';
  END IF;
END
$ledger_preflight$;

DO $preflight$
BEGIN
  IF to_regclass('worker_leave_entry_locators') IS NOT NULL
    OR to_regclass('attendance_event_locators') IS NOT NULL
    OR to_regclass('org_unit_closure') IS NOT NULL
    OR to_regclass('hr_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_DOWN_REFUSED_LATER_BATCH_PRESENT' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM hrms_migration_profiles
    WHERE history_mode <> 'LEGACY'
  ) OR EXISTS (
    SELECT 1
    FROM worker_assignment_periods
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM worker_reporting_lines
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM worker_engagement_state_events
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM worker_engagements
    WHERE last_state_event_id IS NOT NULL OR state_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_DOWN_REFUSED_CANONICAL_DATA_PRESENT' USING ERRCODE = '55000';
  END IF;
END
$preflight$;

ALTER TABLE worker_engagements
  DROP CONSTRAINT fk_worker_engagements_last_state_projection;

DROP TRIGGER verify_worker_engagement_org_unit_kinds ON worker_engagements;
DROP TRIGGER protect_referenced_org_unit_kinds ON org_units;
DROP TRIGGER verify_assignment_org_unit_kinds ON worker_assignment_periods;
DROP TRIGGER enforce_worker_assignment_period_revision ON worker_assignment_periods;
DROP TRIGGER reject_worker_assignment_period_delete ON worker_assignment_periods;
DROP TRIGGER reject_worker_assignment_period_truncate ON worker_assignment_periods;
DROP TRIGGER enforce_worker_reporting_line_revision ON worker_reporting_lines;
DROP TRIGGER lock_worker_reporting_line_tenant ON worker_reporting_lines;
DROP TRIGGER lock_worker_engagement_state_projection ON worker_engagements;
DROP TRIGGER verify_worker_engagement_state_projection ON worker_engagements;
DROP TRIGGER verify_worker_reporting_line_cycles ON worker_reporting_lines;
DROP TRIGGER reject_worker_reporting_line_delete ON worker_reporting_lines;
DROP TRIGGER reject_worker_reporting_line_truncate ON worker_reporting_lines;
DROP TRIGGER verify_worker_engagement_state_chain ON worker_engagement_state_events;
DROP TRIGGER lock_worker_engagement_state_event ON worker_engagement_state_events;
DROP TRIGGER reject_worker_engagement_state_event_mutation ON worker_engagement_state_events;
DROP TRIGGER reject_worker_engagement_state_event_truncate ON worker_engagement_state_events;

DROP FUNCTION app.verify_worker_engagement_state_chain();
DROP FUNCTION app.verify_worker_engagement_state_projection();
DROP FUNCTION app.verify_worker_reporting_line_cycles();
DROP FUNCTION app.lock_worker_engagement_state_transition();
DROP FUNCTION app.lock_worker_reporting_line_tenant();
DROP FUNCTION app.enforce_workforce_period_revision();
DROP FUNCTION app.verify_workforce_org_unit_kinds();

DROP TABLE worker_engagement_state_events RESTRICT;
DROP TABLE worker_reporting_lines RESTRICT;
DROP TABLE worker_assignment_periods RESTRICT;

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
    AND operation.file_name = '0001_hrms_effective_history.sql'
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

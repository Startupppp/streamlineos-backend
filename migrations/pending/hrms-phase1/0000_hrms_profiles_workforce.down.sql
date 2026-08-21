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
  IF target_file_name <> '0000_hrms_profiles_workforce.sql' THEN
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
    SELECT 1
    FROM app.hrms_sql_bundle_operations operation
    WHERE operation.operation_id <> target_operation_id
      AND operation.file_name = target_file_name
      AND operation.database_name = current_database()
      AND operation.state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_ROLLBACK_COMPLETE_TARGET_AMBIGUOUS' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations operation
    WHERE operation.database_name = current_database()
      AND operation.file_name IN (
        '0001_hrms_effective_history.sql',
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
  IF to_regclass('worker_assignment_periods') IS NOT NULL
    OR to_regclass('worker_reporting_lines') IS NOT NULL
    OR to_regclass('worker_engagement_state_events') IS NOT NULL
    OR to_regclass('worker_leave_entry_locators') IS NOT NULL
    OR to_regclass('attendance_event_locators') IS NOT NULL
    OR to_regclass('org_unit_closure') IS NOT NULL
    OR to_regclass('hr_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'HRMS_PROFILE_DOWN_REFUSED_LATER_BATCH_PRESENT' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM hrms_migration_profile_events LIMIT 1)
    OR EXISTS (SELECT 1 FROM hr_person_legacy_map LIMIT 1)
    OR EXISTS (SELECT 1 FROM hr_employment_legacy_map LIMIT 1)
    OR EXISTS (SELECT 1 FROM hr_workforce_reconciliation_items LIMIT 1)
    OR EXISTS (
      SELECT 1
      FROM hrms_migration_profiles
      WHERE profile_revision <> 1
        OR workforce_read_mode <> 'LEGACY'
        OR workforce_write_mode <> 'LEGACY'
        OR history_mode <> 'LEGACY'
        OR hierarchy_read_mode <> 'ADJACENCY'
        OR hierarchy_write_mode <> 'LEGACY_ADAPTER'
        OR attendance_read_mode <> 'LEGACY'
        OR attendance_write_mode <> 'LEGACY'
        OR leave_read_mode <> 'LEGACY'
        OR leave_write_mode <> 'LEGACY'
        OR sensitive_read_mode <> 'LEGACY_ADAPTER'
        OR sensitive_write_mode <> 'LEGACY'
        OR minimum_sensitive_adapter_version <> 1
        OR sensitive_plaintext_writes_retired_at IS NOT NULL
        OR changed_by_platform_user_id IS NOT NULL
        OR change_ticket IS NOT NULL
        OR change_reason IS NOT NULL
        OR rollback_deadline IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM hrms_scope_versions
      WHERE scope_revision <> 1
    )
    OR EXISTS (
      SELECT 1
      FROM hr_people
      WHERE organization_person_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM hr_employments
      WHERE worker_id IS NOT NULL OR worker_engagement_id IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'HRMS_PROFILE_DOWN_REFUSED_CANONICAL_DATA_PRESENT' USING ERRCODE = '55000';
  END IF;
END
$preflight$;

DROP TRIGGER seed_hrms_profile_for_organization ON organizations;
DROP TRIGGER verify_hr_people_workforce_mapping ON hr_people;
DROP TRIGGER verify_hr_employments_workforce_mapping ON hr_employments;
DROP TRIGGER verify_hr_person_legacy_mapping ON hr_person_legacy_map;
DROP TRIGGER verify_hr_employment_legacy_mapping ON hr_employment_legacy_map;
DROP TRIGGER enforce_hr_workforce_reconciliation_transition ON hr_workforce_reconciliation_items;
DROP TRIGGER reject_hr_workforce_reconciliation_delete ON hr_workforce_reconciliation_items;
DROP TRIGGER reject_hr_workforce_reconciliation_truncate ON hr_workforce_reconciliation_items;
DROP TRIGGER verify_hrms_profile_update_event ON hrms_migration_profiles;
DROP TRIGGER verify_hrms_profile_event_update ON hrms_migration_profile_events;
DROP TRIGGER reject_hrms_profile_event_mutation ON hrms_migration_profile_events;
DROP TRIGGER reject_hrms_profile_event_truncate ON hrms_migration_profile_events;
DROP TRIGGER reject_hrms_profile_delete ON hrms_migration_profiles;
DROP TRIGGER reject_hrms_profile_truncate ON hrms_migration_profiles;
DROP TRIGGER enforce_hrms_profile_transition ON hrms_migration_profiles;
DROP TRIGGER enforce_hrms_scope_revision ON hrms_scope_versions;
DROP TRIGGER reject_hrms_scope_delete ON hrms_scope_versions;
DROP TRIGGER reject_hrms_scope_truncate ON hrms_scope_versions;

DROP FUNCTION app.enforce_hr_workforce_reconciliation_transition();
DROP FUNCTION app.verify_hr_workforce_mapping();
DROP TABLE hr_workforce_reconciliation_items RESTRICT;
DROP TABLE hr_employment_legacy_map RESTRICT;
DROP TABLE hr_person_legacy_map RESTRICT;

DROP FUNCTION app.seed_hrms_profile_for_organization();
DROP FUNCTION app.verify_hrms_profile_event_coupling();
DROP FUNCTION app.enforce_hrms_profile_transition();
DROP FUNCTION app.enforce_hrms_scope_revision();
DROP FUNCTION app.hrms_profile_modes_json(hrms_migration_profiles);
DROP TABLE hrms_migration_profile_events RESTRICT;
DROP FUNCTION app.hrms_modes_valid(jsonb);
DROP TABLE hrms_scope_versions RESTRICT;
DROP TABLE hrms_migration_profiles RESTRICT;

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
    AND operation.file_name = '0000_hrms_profiles_workforce.sql'
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

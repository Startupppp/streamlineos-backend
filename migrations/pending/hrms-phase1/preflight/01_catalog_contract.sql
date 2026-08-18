BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2min';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = public, pg_catalog;

WITH expected(relation_name, relation_kind, partition_strategy) AS (
  VALUES
    ('hrms_migration_profiles', 'r'::"char", NULL::"char"),
    ('hrms_migration_profile_events', 'r', NULL),
    ('hrms_scope_versions', 'r', NULL),
    ('hr_person_legacy_map', 'r', NULL),
    ('hr_employment_legacy_map', 'r', NULL),
    ('hr_workforce_reconciliation_items', 'r', NULL),
    ('worker_assignment_periods', 'r', NULL),
    ('worker_reporting_lines', 'r', NULL),
    ('worker_engagement_state_events', 'r', NULL),
    ('worker_leave_entry_locators', 'p', 'h'),
    ('worker_leave_ledger_entries', 'p', 'r'),
    ('worker_leave_reversal_links', 'p', 'h'),
    ('worker_leave_balance_projections', 'r', NULL),
    ('attendance_event_locators', 'p', 'h'),
    ('attendance_events', 'p', 'r'),
    ('attendance_correction_links', 'p', 'h'),
    ('attendance_event_evidence', 'p', 'r'),
    ('attendance_evidence_legal_holds', 'r', NULL),
    ('attendance_session_projections', 'r', NULL),
    ('attendance_daily_projections', 'r', NULL),
    ('org_unit_closure', 'r', NULL),
    ('hr_audit_event_sources', 'p', 'h'),
    ('hr_audit_events', 'p', 'r')
), actual AS (
  SELECT
    class.relname AS relation_name,
    class.relkind AS relation_kind,
    partitioned.partstrat AS partition_strategy
  FROM pg_class class
  JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
  LEFT JOIN pg_partitioned_table partitioned
    ON partitioned.partrelid = class.oid
  WHERE namespace.nspname = 'public'
)
SELECT
  expected.relation_name,
  expected.relation_kind AS expected_kind,
  actual.relation_kind AS actual_kind,
  expected.partition_strategy AS expected_strategy,
  actual.partition_strategy AS actual_strategy
FROM expected
LEFT JOIN actual USING (relation_name)
WHERE actual.relation_name IS NULL
   OR actual.relation_kind <> expected.relation_kind
   OR actual.partition_strategy IS DISTINCT FROM expected.partition_strategy
ORDER BY expected.relation_name;

WITH expected(constraint_name, deferrable, initially_deferred) AS (
  VALUES
    ('fk_worker_leave_entries_locator', true, true),
    ('fk_worker_leave_locators_fact', true, true),
    ('fk_worker_leave_reversal_original_fact', true, true),
    ('fk_worker_leave_reversal_reversal_fact', true, true),
    ('fk_attendance_events_locator', true, true),
    ('fk_attendance_event_locators_fact', true, true),
    ('fk_attendance_events_correction_target', true, true),
    ('fk_attendance_correction_links_original_fact', true, true),
    ('fk_attendance_correction_links_correction_fact', true, true),
    ('fk_hr_audit_events_source', true, true),
    ('fk_hr_audit_event_sources_fact', true, true),
    ('fk_worker_engagements_last_state_projection', true, true)
), actual AS (
  SELECT conname, condeferrable, condeferred
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace
)
SELECT
  expected.constraint_name,
  expected.deferrable AS expected_deferrable,
  actual.condeferrable AS actual_deferrable,
  expected.initially_deferred AS expected_initially_deferred,
  actual.condeferred AS actual_initially_deferred
FROM expected
LEFT JOIN actual ON actual.conname = expected.constraint_name
WHERE actual.conname IS NULL
   OR actual.condeferrable <> expected.deferrable
   OR actual.condeferred <> expected.initially_deferred
ORDER BY expected.constraint_name;

SELECT
  parent.relname AS parent_name,
  child.relname AS default_partition_name
FROM pg_inherits inheritance
JOIN pg_class parent ON parent.oid = inheritance.inhparent
JOIN pg_class child ON child.oid = inheritance.inhrelid
WHERE pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'
  AND parent.relname IN (
    'worker_leave_ledger_entries',
    'attendance_events',
    'attendance_event_evidence',
    'hr_audit_events'
  )
ORDER BY parent.relname, child.relname;

WITH protected(relation_name) AS (
  VALUES
    ('org_unit_closure'),
    ('worker_leave_entry_locators'),
    ('worker_leave_ledger_entries'),
    ('worker_leave_reversal_links'),
    ('worker_leave_balance_projections'),
    ('attendance_event_locators'),
    ('attendance_events'),
    ('attendance_correction_links'),
    ('attendance_event_evidence'),
    ('attendance_evidence_legal_holds'),
    ('attendance_session_projections'),
    ('attendance_daily_projections'),
    ('hr_audit_event_sources'),
    ('hr_audit_events')
), app_role AS (
  SELECT coalesce(
    nullif(current_setting('app.bootstrap_role', true), ''),
    'streamline_app'
  ) AS role_name
)
SELECT
  protected.relation_name,
  privilege.privilege_type
FROM protected
CROSS JOIN app_role
CROSS JOIN LATERAL (
  VALUES
    ('SELECT', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'SELECT'
    )),
    ('INSERT', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'INSERT'
    )),
    ('UPDATE', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'UPDATE'
    )),
    ('DELETE', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'DELETE'
    )),
    ('TRUNCATE', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'TRUNCATE'
    )),
    ('REFERENCES', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'REFERENCES'
    )),
    ('TRIGGER', has_table_privilege(
      app_role.role_name,
      protected.relation_name,
      'TRIGGER'
    )),
    ('COLUMN_SELECT', has_any_column_privilege(
      app_role.role_name,
      protected.relation_name,
      'SELECT'
    )),
    ('COLUMN_INSERT', has_any_column_privilege(
      app_role.role_name,
      protected.relation_name,
      'INSERT'
    )),
    ('COLUMN_UPDATE', has_any_column_privilege(
      app_role.role_name,
      protected.relation_name,
      'UPDATE'
    )),
    ('COLUMN_REFERENCES', has_any_column_privilege(
      app_role.role_name,
      protected.relation_name,
      'REFERENCES'
    )),
    ('MAINTAIN', CASE
      WHEN current_setting('server_version_num')::integer >= 170000
      THEN has_table_privilege(
        app_role.role_name,
        protected.relation_name,
        'MAINTAIN'
      )
      ELSE false
    END)
) privilege(privilege_type, granted)
WHERE privilege.granted
ORDER BY protected.relation_name, privilege.privilege_type;

WITH protected(relation_name) AS (
  VALUES
    ('org_unit_closure'),
    ('worker_leave_entry_locators'),
    ('worker_leave_ledger_entries'),
    ('worker_leave_reversal_links'),
    ('worker_leave_balance_projections'),
    ('attendance_event_locators'),
    ('attendance_events'),
    ('attendance_correction_links'),
    ('attendance_event_evidence'),
    ('attendance_evidence_legal_holds'),
    ('attendance_session_projections'),
    ('attendance_daily_projections'),
    ('hr_audit_event_sources'),
    ('hr_audit_events')
), relation_acl AS (
  SELECT protected.relation_name, privilege.privilege_type
  FROM protected
  JOIN pg_class relation ON relation.oid = protected.relation_name::regclass
  CROSS JOIN LATERAL aclexplode(coalesce(
    relation.relacl,
    acldefault('r', relation.relowner)
  )) privilege
  WHERE privilege.grantee = 0
), column_acl AS (
  SELECT protected.relation_name,
    'COLUMN_' || privilege.privilege_type AS privilege_type
  FROM protected
  JOIN pg_class relation ON relation.oid = protected.relation_name::regclass
  JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
  CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND privilege.grantee = 0
)
SELECT relation_name, privilege_type
FROM relation_acl
UNION ALL
SELECT relation_name, privilege_type
FROM column_acl
ORDER BY relation_name, privilege_type;

WITH protected(sequence_name) AS (
  VALUES
    ('worker_leave_entry_locators_entry_id_seq'),
    ('attendance_event_locators_event_id_seq'),
    ('attendance_event_evidence_evidence_id_seq'),
    ('attendance_session_projections_session_id_seq'),
    ('hr_audit_event_sources_audit_event_id_seq')
), app_role AS (
  SELECT coalesce(
    nullif(current_setting('app.bootstrap_role', true), ''),
    'streamline_app'
  ) AS role_name
)
SELECT
  protected.sequence_name,
  privilege.privilege_type
FROM protected
CROSS JOIN app_role
CROSS JOIN LATERAL (
  VALUES
    ('USAGE', has_sequence_privilege(
      app_role.role_name,
      protected.sequence_name,
      'USAGE'
    )),
    ('SELECT', has_sequence_privilege(
      app_role.role_name,
      protected.sequence_name,
      'SELECT'
    )),
    ('UPDATE', has_sequence_privilege(
      app_role.role_name,
      protected.sequence_name,
      'UPDATE'
    ))
) privilege(privilege_type, granted)
WHERE privilege.granted
ORDER BY protected.sequence_name, privilege.privilege_type;

WITH protected(sequence_name) AS (
  VALUES
    ('worker_leave_entry_locators_entry_id_seq'),
    ('attendance_event_locators_event_id_seq'),
    ('attendance_event_evidence_evidence_id_seq'),
    ('attendance_session_projections_session_id_seq'),
    ('hr_audit_event_sources_audit_event_id_seq')
)
SELECT protected.sequence_name, privilege.privilege_type
FROM protected
JOIN pg_class sequence ON sequence.oid = protected.sequence_name::regclass
CROSS JOIN LATERAL aclexplode(coalesce(
  sequence.relacl,
  acldefault('S', sequence.relowner)
)) privilege
WHERE privilege.grantee = 0
ORDER BY protected.sequence_name, privilege.privilege_type;

SELECT organization_id, profile_revision
FROM hrms_migration_profiles
WHERE workforce_read_mode <> 'LEGACY'
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
ORDER BY organization_id;

SELECT
  class.relname AS relation_name,
  class.relrowsecurity AS rls_enabled,
  count(policy.policyname) FILTER (
    WHERE policy.policyname = 'tenant_isolation'
  )::integer AS tenant_policy_count
FROM pg_class class
JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
LEFT JOIN pg_policies policy
  ON policy.schemaname = namespace.nspname
 AND policy.tablename = class.relname
WHERE namespace.nspname = 'public'
  AND class.relname IN (
    'hrms_migration_profiles',
    'hrms_migration_profile_events',
    'hrms_scope_versions',
    'hr_person_legacy_map',
    'hr_employment_legacy_map',
    'hr_workforce_reconciliation_items',
    'worker_assignment_periods',
    'worker_reporting_lines',
    'worker_engagement_state_events',
    'worker_leave_entry_locators',
    'worker_leave_ledger_entries',
    'worker_leave_reversal_links',
    'worker_leave_balance_projections',
    'attendance_event_locators',
    'attendance_events',
    'attendance_correction_links',
    'attendance_event_evidence',
    'attendance_evidence_legal_holds',
    'attendance_session_projections',
    'attendance_daily_projections',
    'org_unit_closure',
    'hr_audit_event_sources',
    'hr_audit_events'
  )
GROUP BY class.relname, class.relrowsecurity
HAVING NOT class.relrowsecurity
    OR count(policy.policyname) FILTER (
      WHERE policy.policyname = 'tenant_isolation'
    ) <> 1
ORDER BY class.relname;

ROLLBACK;

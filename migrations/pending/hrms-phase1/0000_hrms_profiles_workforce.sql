SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $preflight$
DECLARE
  app_namespace oid;
  app_namespace_owner oid;
  migration_user oid;
  migration_user_is_super boolean;
  application_role text := coalesce(nullif(current_setting('app.bootstrap_role', true), ''), 'streamline_app');
  execution_role text := coalesce(nullif(current_setting('app.hrms_migration_role', true), ''), 'streamline_hrms_migration');
  bundle_operation_id text := nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '');
  bundle_id text := nullif(btrim(current_setting('app.hrms_bundle_id', true)), '');
  bundle_file_name text := nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '');
  bundle_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '');
  bundle_manifest_hash text := nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '');
  bundle_root_migration_hash text := nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '');
  existing_function record;
BEGIN
  SELECT oid, nspowner INTO app_namespace, app_namespace_owner
  FROM pg_namespace
  WHERE nspname = 'app';
  IF app_namespace IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_APP_SCHEMA_MISSING' USING ERRCODE = '3F000';
  END IF;
  IF to_regnamespace('public') IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_PUBLIC_SCHEMA_MISSING' USING ERRCODE = '3F000';
  END IF;
  IF to_regprocedure('app.current_org_id()') IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_CURRENT_ORG_ID_MISSING' USING ERRCODE = '42883';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM aclexplode(coalesce(
      (SELECT nspacl FROM pg_namespace WHERE oid = app_namespace),
      acldefault('n', app_namespace_owner)
    )) acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_APP_SCHEMA_PUBLIC_CREATE' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(coalesce(
      namespace.nspacl,
      acldefault('n', namespace.nspowner)
    )) acl
    WHERE namespace.nspname = 'public'
      AND acl.grantee = 0
      AND acl.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_PUBLIC_SCHEMA_PUBLIC_CREATE' USING ERRCODE = '42501';
  END IF;
  SELECT oid, rolsuper INTO migration_user, migration_user_is_super
  FROM pg_roles
  WHERE rolname = current_user;
  IF NOT migration_user_is_super
    AND migration_user <> app_namespace_owner
    AND NOT has_schema_privilege(current_user, 'app', 'CREATE') THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_APP_SCHEMA_CREATE_DENIED' USING ERRCODE = '42501';
  END IF;
  FOR existing_function IN
    SELECT p.oid::regprocedure AS identity, p.proowner
    FROM pg_proc p
    WHERE p.pronamespace = app_namespace
      AND p.proname IN (
        'reject_hrms_append_only_mutation',
        'hrms_modes_valid',
        'hrms_profile_modes_json',
        'enforce_hrms_profile_transition',
        'verify_hrms_profile_event_coupling',
        'seed_hrms_profile_for_organization',
        'enforce_hrms_scope_revision',
        'verify_hr_workforce_mapping',
        'enforce_hr_workforce_reconciliation_transition',
        'enforce_hrms_bundle_operation_transition'
      )
  LOOP
    IF NOT migration_user_is_super AND existing_function.proowner <> migration_user THEN
      RAISE EXCEPTION 'HRMS_PREFLIGHT_FUNCTION_OWNER_MISMATCH: %', existing_function.identity
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_APPLICATION_ROLE_MISSING: %', application_role
      USING ERRCODE = '42704';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = execution_role) THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_EXECUTION_ROLE_MISSING: %', execution_role
      USING ERRCODE = '42704';
  END IF;
  IF application_role = execution_role OR application_role = current_user OR execution_role = current_user THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_ROLES_MUST_BE_DISTINCT' USING ERRCODE = '42501';
  END IF;
  IF pg_has_role(application_role, execution_role, 'MEMBER')
    OR pg_has_role(application_role, current_user, 'MEMBER')
    OR pg_has_role(execution_role, current_user, 'MEMBER') THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_RUNTIME_ROLE_INHERITS_PRIVILEGED_ROLE' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN (application_role, execution_role)
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_RUNTIME_ROLE_BYPASSES_RLS' USING ERRCODE = '42501';
  END IF;
  IF bundle_operation_id IS NULL
    OR bundle_id IS NULL
    OR bundle_file_name IS NULL
    OR bundle_sql_hash IS NULL
    OR bundle_manifest_hash IS NULL
    OR bundle_root_migration_hash IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_METADATA_MISSING' USING ERRCODE = '22023';
  END IF;
  IF bundle_file_name <> '0000_hrms_profiles_workforce.sql' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF bundle_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_manifest_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_root_migration_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS app.hrms_sql_bundle_operations (
  operation_id text PRIMARY KEY,
  bundle_id text NOT NULL,
  file_name text NOT NULL,
  sql_hash text NOT NULL,
  manifest_hash text NOT NULL,
  root_migration_hash text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  database_name text NOT NULL,
  database_role text NOT NULL,
  server_version_num integer NOT NULL,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  last_error text,
  CONSTRAINT chk_hrms_sql_bundle_operations_identity CHECK (
    char_length(operation_id) BETWEEN 3 AND 512
    AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$'
    AND char_length(bundle_id) BETWEEN 3 AND 129
    AND bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]*$'
    AND file_name IN (
      '0000_hrms_profiles_workforce.sql',
      '0001_hrms_effective_history.sql',
      '0002_hrms_leave_ledger.sql',
      '0003_hrms_attendance_events.sql',
      '0004_hrms_hierarchy_audit.sql'
    )
    AND char_length(database_name) BETWEEN 1 AND 63
    AND database_name ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
    AND char_length(database_role) BETWEEN 1 AND 63
    AND database_role ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
  ),
  CONSTRAINT chk_hrms_sql_bundle_operations_hashes CHECK (
    sql_hash ~ '^[0-9a-f]{64}$'
    AND manifest_hash ~ '^[0-9a-f]{64}$'
    AND root_migration_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_hrms_sql_bundle_operations_state CHECK (
    state IN ('RUNNING', 'VERIFYING', 'COMPLETE', 'FAILED', 'ROLLED_BACK')
  ),
  CONSTRAINT chk_hrms_sql_bundle_operations_attempts CHECK (attempts > 0),
  CONSTRAINT chk_hrms_sql_bundle_operations_server_version CHECK (server_version_num > 0),
  CONSTRAINT chk_hrms_sql_bundle_operations_error CHECK (
    last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_.:-]{0,255}$'
  ),
  CONSTRAINT chk_hrms_sql_bundle_operations_timestamps CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT chk_hrms_sql_bundle_operations_shape CHECK (
    (
      state IN ('RUNNING', 'VERIFYING')
      AND completed_at IS NULL
      AND last_error IS NULL
    )
    OR (
      state IN ('COMPLETE', 'ROLLED_BACK')
      AND completed_at IS NOT NULL
      AND last_error IS NULL
    )
    OR (
      state = 'FAILED'
      AND completed_at IS NOT NULL
      AND last_error IS NOT NULL
    )
  )
);

CREATE OR REPLACE FUNCTION app.reject_hrms_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'HRMS_APPEND_ONLY_VIOLATION: %.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_hrms_bundle_operation_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempts <> 1
      OR NEW.database_name <> current_database()
      OR NEW.database_role <> current_user
      OR NEW.server_version_num <> current_setting('server_version_num')::integer THEN
      RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_INITIAL_IDENTITY_INVALID'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state IN ('RUNNING', 'FAILED') THEN
      RETURN NEW;
    END IF;
    IF NEW.state = 'COMPLETE'
      AND NEW.file_name = '0000_hrms_profiles_workforce.sql'
      AND NEW.operation_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '')
      AND NEW.bundle_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_id', true)), '')
      AND NEW.file_name IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '')
      AND NEW.sql_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '')
      AND NEW.manifest_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '')
      AND NEW.root_migration_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_INITIAL_STATE_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
    NEW.operation_id,
    NEW.bundle_id,
    NEW.file_name,
    NEW.sql_hash,
    NEW.manifest_hash,
    NEW.root_migration_hash,
    NEW.database_name,
    NEW.database_role,
    NEW.server_version_num
  ) IS DISTINCT FROM ROW(
    OLD.operation_id,
    OLD.bundle_id,
    OLD.file_name,
    OLD.sql_hash,
    OLD.manifest_hash,
    OLD.root_migration_hash,
    OLD.database_name,
    OLD.database_role,
    OLD.server_version_num
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_IDENTITY_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.database_name <> current_database()
    OR OLD.database_role <> current_user
    OR OLD.server_version_num <> current_setting('server_version_num')::integer THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_EXECUTION_IDENTITY_INVALID'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (
      OLD.state = 'FAILED'
      AND NEW.state IN ('RUNNING', 'FAILED')
      AND NEW.attempts = OLD.attempts + 1
      AND NEW.started_at > OLD.started_at
    )
    OR (
      OLD.state = 'ROLLED_BACK'
      AND NEW.state IN ('RUNNING', 'FAILED')
      AND NEW.attempts = OLD.attempts + 1
      AND NEW.started_at > OLD.started_at
      AND NEW.operation_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '')
      AND NEW.bundle_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_id', true)), '')
      AND NEW.file_name IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '')
      AND NEW.sql_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '')
      AND NEW.manifest_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '')
      AND NEW.root_migration_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '')
    )
    OR (
      OLD.state = 'RUNNING'
      AND NEW.state = 'VERIFYING'
      AND NEW.attempts = OLD.attempts
      AND NEW.started_at = OLD.started_at
    )
    OR (
      OLD.state = 'VERIFYING'
      AND NEW.state = 'COMPLETE'
      AND NEW.attempts = OLD.attempts
      AND NEW.started_at = OLD.started_at
    )
    OR (
      OLD.state = 'COMPLETE'
      AND NEW.state = 'ROLLED_BACK'
      AND NEW.attempts = OLD.attempts
      AND NEW.started_at = OLD.started_at
      AND NEW.completed_at >= OLD.completed_at
      AND NEW.operation_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '')
      AND NEW.bundle_id IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_id', true)), '')
      AND NEW.file_name IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '')
      AND NEW.sql_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '')
      AND NEW.manifest_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '')
      AND NEW.root_migration_hash IS NOT DISTINCT FROM nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '')
    )
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_TRANSITION_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.enforce_hrms_bundle_operation_transition() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_hrms_bundle_operation_transition ON app.hrms_sql_bundle_operations;
DROP TRIGGER IF EXISTS reject_hrms_bundle_operation_delete ON app.hrms_sql_bundle_operations;
DROP TRIGGER IF EXISTS reject_hrms_bundle_operation_truncate ON app.hrms_sql_bundle_operations;
CREATE TRIGGER enforce_hrms_bundle_operation_transition
  BEFORE INSERT OR UPDATE ON app.hrms_sql_bundle_operations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_hrms_bundle_operation_transition();
CREATE TRIGGER reject_hrms_bundle_operation_delete
  BEFORE DELETE ON app.hrms_sql_bundle_operations
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_bundle_operation_truncate
  BEFORE TRUNCATE ON app.hrms_sql_bundle_operations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();

ALTER TABLE organization_people
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer;

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer;

ALTER TABLE worker_engagements
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer;

ALTER TABLE hr_people
  ADD COLUMN IF NOT EXISTS organization_person_id text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer;

ALTER TABLE hr_employments
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_engagement_id text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_workers_org_person_worker
  ON workers (organization_id, organization_person_id, worker_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_worker_engagements_org_worker_engagement
  ON worker_engagements (organization_id, worker_id, worker_engagement_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_people_org_id
  ON hr_people (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_employments_org_id
  ON hr_employments (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_employments_org_id_person
  ON hr_employments (org_id, id, person_id);

DO $candidate_keys$
DECLARE
  candidate record;
BEGIN
  FOR candidate IN
    SELECT * FROM (VALUES
      ('workers', 'uniq_workers_org_person_worker'),
      ('worker_engagements', 'uniq_worker_engagements_org_worker_engagement'),
      ('hr_people', 'uniq_hr_people_org_id'),
      ('hr_employments', 'uniq_hr_employments_org_id'),
      ('hr_employments', 'uniq_hr_employments_org_id_person'),
      ('worker_engagements', 'uniq_worker_engagements_org_engagement')
    ) AS candidates(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(candidate.table_name)
        AND conname = candidate.constraint_name
    ) THEN
      IF to_regclass(candidate.constraint_name) IS NULL THEN
        RAISE EXCEPTION 'HRMS_CANDIDATE_INDEX_MISSING: %', candidate.constraint_name
          USING ERRCODE = '42P01';
      END IF;
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I UNIQUE USING INDEX %I',
        candidate.table_name,
        candidate.constraint_name,
        candidate.constraint_name
      );
    END IF;
  END LOOP;
END
$candidate_keys$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_people_active_work_email_ci
  ON organization_people (organization_id, lower(work_email))
  WHERE work_email IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_workers_active_org_number
  ON workers (organization_id, worker_number)
  WHERE worker_number IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_worker_engagements_active_primary_unarchived
  ON worker_engagements (organization_id, worker_id)
  WHERE is_primary = true AND status = 'ACTIVE' AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_people_org_person_link
  ON hr_people (org_id, organization_person_id)
  WHERE organization_person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_employments_org_engagement_link
  ON hr_employments (org_id, worker_engagement_id)
  WHERE worker_engagement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_org_people_updated_actor
  ON organization_people (organization_id, updated_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_org_people_archived_actor
  ON organization_people (organization_id, archived_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_workers_created_actor
  ON workers (organization_id, created_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_workers_updated_actor
  ON workers (organization_id, updated_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_workers_archived_actor
  ON workers (organization_id, archived_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_created_actor
  ON worker_engagements (organization_id, created_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_updated_actor
  ON worker_engagements (organization_id, updated_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_archived_actor
  ON worker_engagements (organization_id, archived_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_hr_people_updated_actor
  ON hr_people (org_id, updated_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_hr_people_archived_actor
  ON hr_people (org_id, archived_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_hr_employments_worker
  ON hr_employments (org_id, worker_id);
CREATE INDEX IF NOT EXISTS idx_hr_employments_updated_actor
  ON hr_employments (org_id, updated_by_membership_id);
CREATE INDEX IF NOT EXISTS idx_hr_employments_archived_actor
  ON hr_employments (org_id, archived_by_membership_id);

DO $existing_constraints$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('organization_people', 'chk_org_people_row_version', 'CHECK (row_version > 0) NOT VALID'),
      ('organization_people', 'fk_org_people_org_membership', 'FOREIGN KEY (organization_id, organization_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('organization_people', 'fk_org_people_updated_actor', 'FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('organization_people', 'fk_org_people_archived_actor', 'FOREIGN KEY (organization_id, archived_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('workers', 'chk_workers_row_version', 'CHECK (row_version > 0) NOT VALID'),
      ('workers', 'chk_workers_status', 'CHECK (status IN (''ACTIVE'', ''INACTIVE'', ''EXITED'')) NOT VALID'),
      ('workers', 'fk_workers_created_actor', 'FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('workers', 'fk_workers_updated_actor', 'FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('workers', 'fk_workers_archived_actor', 'FOREIGN KEY (organization_id, archived_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'chk_worker_engagements_row_version', 'CHECK (row_version > 0) NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_created_actor', 'FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_updated_actor', 'FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_archived_actor', 'FOREIGN KEY (organization_id, archived_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('hr_people', 'chk_hr_people_row_version', 'CHECK (row_version > 0) NOT VALID'),
      ('hr_people', 'fk_hr_people_org_person', 'FOREIGN KEY (org_id, organization_person_id) REFERENCES organization_people (organization_id, organization_person_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID'),
      ('hr_people', 'fk_hr_people_updated_actor', 'FOREIGN KEY (org_id, updated_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('hr_people', 'fk_hr_people_archived_actor', 'FOREIGN KEY (org_id, archived_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('hr_employments', 'chk_hr_employments_canonical_link', 'CHECK ((worker_id IS NULL) = (worker_engagement_id IS NULL)) NOT VALID'),
      ('hr_employments', 'chk_hr_employments_row_version', 'CHECK (row_version > 0) NOT VALID'),
      ('hr_employments', 'fk_hr_employments_org_person', 'FOREIGN KEY (org_id, person_id) REFERENCES hr_people (org_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID'),
      ('hr_employments', 'fk_hr_employments_org_worker', 'FOREIGN KEY (org_id, worker_id) REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID'),
      ('hr_employments', 'fk_hr_employments_org_worker_engagement', 'FOREIGN KEY (org_id, worker_id, worker_engagement_id) REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID'),
      ('hr_employments', 'fk_hr_employments_updated_actor', 'FOREIGN KEY (org_id, updated_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('hr_employments', 'fk_hr_employments_archived_actor', 'FOREIGN KEY (org_id, archived_by_membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID')
    ) AS constraints(table_name, constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(item.table_name)
        AND conname = item.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I %s',
        item.table_name,
        item.constraint_name,
        item.definition
      );
    END IF;
  END LOOP;
END
$existing_constraints$;

CREATE OR REPLACE FUNCTION app.hrms_modes_valid(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_typeof(value) = 'object'
    AND value ?& ARRAY[
      'workforceReadMode',
      'workforceWriteMode',
      'historyMode',
      'hierarchyReadMode',
      'hierarchyWriteMode',
      'attendanceReadMode',
      'attendanceWriteMode',
      'leaveReadMode',
      'leaveWriteMode',
      'sensitiveReadMode',
      'sensitiveWriteMode'
    ]
    AND value - ARRAY[
      'workforceReadMode',
      'workforceWriteMode',
      'historyMode',
      'hierarchyReadMode',
      'hierarchyWriteMode',
      'attendanceReadMode',
      'attendanceWriteMode',
      'leaveReadMode',
      'leaveWriteMode',
      'sensitiveReadMode',
      'sensitiveWriteMode'
    ] = '{}'::jsonb
    AND (value->>'workforceReadMode', value->>'workforceWriteMode') IN (
      ('LEGACY', 'LEGACY'),
      ('LEGACY', 'DUAL'),
      ('SHADOW', 'DUAL'),
      ('CANONICAL', 'CANONICAL_WITH_PROJECTION')
    )
    AND value->>'historyMode' IN ('LEGACY', 'DUAL', 'EFFECTIVE')
    AND (value->>'hierarchyReadMode', value->>'hierarchyWriteMode') IN (
      ('ADJACENCY', 'LEGACY_ADAPTER'),
      ('SHADOW_CLOSURE', 'LOCKED_COMMAND'),
      ('CLOSURE', 'LOCKED_COMMAND')
    )
    AND (value->>'attendanceReadMode', value->>'attendanceWriteMode') IN (
      ('LEGACY', 'LEGACY'),
      ('LEGACY', 'DUAL'),
      ('SHADOW', 'DUAL'),
      ('EVENT', 'EVENT_WITH_PROJECTION')
    )
    AND (value->>'leaveReadMode', value->>'leaveWriteMode') IN (
      ('LEGACY', 'LEGACY'),
      ('LEGACY', 'DUAL'),
      ('SHADOW', 'DUAL'),
      ('LEDGER', 'LEDGER_WITH_PROJECTION')
    )
    AND (value->>'sensitiveReadMode', value->>'sensitiveWriteMode') IN (
      ('LEGACY_ADAPTER', 'LEGACY'),
      ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED'),
      ('SHADOW_ENCRYPTED', 'DUAL_ENCRYPTED'),
      ('ENCRYPTED', 'ENCRYPTED'),
      ('SHADOW_ENCRYPTED', 'ENCRYPTED'),
      ('LEGACY_ADAPTER', 'ENCRYPTED')
    )
$function$;

CREATE TABLE hrms_migration_profiles (
  organization_id text PRIMARY KEY REFERENCES organizations (id) ON DELETE RESTRICT,
  workforce_read_mode text NOT NULL DEFAULT 'LEGACY',
  workforce_write_mode text NOT NULL DEFAULT 'LEGACY',
  history_mode text NOT NULL DEFAULT 'LEGACY',
  hierarchy_read_mode text NOT NULL DEFAULT 'ADJACENCY',
  hierarchy_write_mode text NOT NULL DEFAULT 'LEGACY_ADAPTER',
  attendance_read_mode text NOT NULL DEFAULT 'LEGACY',
  attendance_write_mode text NOT NULL DEFAULT 'LEGACY',
  leave_read_mode text NOT NULL DEFAULT 'LEGACY',
  leave_write_mode text NOT NULL DEFAULT 'LEGACY',
  sensitive_read_mode text NOT NULL DEFAULT 'LEGACY_ADAPTER',
  sensitive_write_mode text NOT NULL DEFAULT 'LEGACY',
  minimum_sensitive_adapter_version integer NOT NULL DEFAULT 1,
  sensitive_plaintext_writes_retired_at timestamp with time zone,
  profile_revision bigint NOT NULL DEFAULT 1,
  changed_at timestamp with time zone NOT NULL DEFAULT now(),
  changed_by_platform_user_id text REFERENCES users (id) ON DELETE RESTRICT,
  change_ticket text,
  change_reason text,
  rollback_deadline timestamp with time zone,
  CONSTRAINT chk_hrms_profile_revision CHECK (profile_revision > 0),
  CONSTRAINT chk_hrms_profile_sensitive_adapter_version CHECK (minimum_sensitive_adapter_version > 0),
  CONSTRAINT chk_hrms_profile_workforce_modes CHECK ((workforce_read_mode, workforce_write_mode) IN (
    ('LEGACY', 'LEGACY'),
    ('LEGACY', 'DUAL'),
    ('SHADOW', 'DUAL'),
    ('CANONICAL', 'CANONICAL_WITH_PROJECTION')
  )),
  CONSTRAINT chk_hrms_profile_history_mode CHECK (history_mode IN ('LEGACY', 'DUAL', 'EFFECTIVE')),
  CONSTRAINT chk_hrms_profile_hierarchy_modes CHECK ((hierarchy_read_mode, hierarchy_write_mode) IN (
    ('ADJACENCY', 'LEGACY_ADAPTER'),
    ('SHADOW_CLOSURE', 'LOCKED_COMMAND'),
    ('CLOSURE', 'LOCKED_COMMAND')
  )),
  CONSTRAINT chk_hrms_profile_attendance_modes CHECK ((attendance_read_mode, attendance_write_mode) IN (
    ('LEGACY', 'LEGACY'),
    ('LEGACY', 'DUAL'),
    ('SHADOW', 'DUAL'),
    ('EVENT', 'EVENT_WITH_PROJECTION')
  )),
  CONSTRAINT chk_hrms_profile_leave_modes CHECK ((leave_read_mode, leave_write_mode) IN (
    ('LEGACY', 'LEGACY'),
    ('LEGACY', 'DUAL'),
    ('SHADOW', 'DUAL'),
    ('LEDGER', 'LEDGER_WITH_PROJECTION')
  )),
  CONSTRAINT chk_hrms_profile_sensitive_modes CHECK ((sensitive_read_mode, sensitive_write_mode) IN (
    ('LEGACY_ADAPTER', 'LEGACY'),
    ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED'),
    ('SHADOW_ENCRYPTED', 'DUAL_ENCRYPTED'),
    ('ENCRYPTED', 'ENCRYPTED'),
    ('SHADOW_ENCRYPTED', 'ENCRYPTED'),
    ('LEGACY_ADAPTER', 'ENCRYPTED')
  )),
  CONSTRAINT chk_hrms_profile_sensitive_retirement CHECK (
    (sensitive_write_mode = 'LEGACY') = (sensitive_plaintext_writes_retired_at IS NULL)
  ),
  CONSTRAINT chk_hrms_profile_change_metadata CHECK (
    (change_ticket IS NULL OR btrim(change_ticket) <> '')
    AND (change_reason IS NULL OR btrim(change_reason) <> '')
    AND (
      profile_revision = 1
      OR (
        changed_by_platform_user_id IS NOT NULL
        AND change_ticket IS NOT NULL
        AND change_reason IS NOT NULL
      )
    )
  ),
  CONSTRAINT chk_hrms_profile_initial_state CHECK (
    profile_revision <> 1
    OR (
      workforce_read_mode = 'LEGACY'
      AND workforce_write_mode = 'LEGACY'
      AND history_mode = 'LEGACY'
      AND hierarchy_read_mode = 'ADJACENCY'
      AND hierarchy_write_mode = 'LEGACY_ADAPTER'
      AND attendance_read_mode = 'LEGACY'
      AND attendance_write_mode = 'LEGACY'
      AND leave_read_mode = 'LEGACY'
      AND leave_write_mode = 'LEGACY'
      AND sensitive_read_mode = 'LEGACY_ADAPTER'
      AND sensitive_write_mode = 'LEGACY'
      AND sensitive_plaintext_writes_retired_at IS NULL
    )
  )
);

CREATE INDEX idx_hrms_profiles_changed_actor
  ON hrms_migration_profiles (changed_by_platform_user_id);

CREATE TABLE hrms_migration_profile_events (
  organization_id text NOT NULL REFERENCES hrms_migration_profiles (organization_id) ON DELETE RESTRICT,
  profile_revision bigint NOT NULL,
  before_modes jsonb NOT NULL,
  after_modes jsonb NOT NULL,
  manifest_hash text NOT NULL,
  proposed_by_platform_user_id text NOT NULL,
  approved_by_platform_user_id text NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pk_hrms_migration_profile_events PRIMARY KEY (organization_id, profile_revision),
  CONSTRAINT chk_hrms_profile_events_revision CHECK (profile_revision > 1),
  CONSTRAINT chk_hrms_profile_events_distinct_actors CHECK (
    proposed_by_platform_user_id <> approved_by_platform_user_id
  ),
  CONSTRAINT chk_hrms_profile_events_actor_snapshots CHECK (
    btrim(proposed_by_platform_user_id) <> ''
    AND btrim(approved_by_platform_user_id) <> ''
  ),
  CONSTRAINT chk_hrms_profile_events_manifest_hash CHECK (btrim(manifest_hash) <> ''),
  CONSTRAINT chk_hrms_profile_events_before_modes CHECK (app.hrms_modes_valid(before_modes)),
  CONSTRAINT chk_hrms_profile_events_after_modes CHECK (app.hrms_modes_valid(after_modes))
);

CREATE INDEX idx_hrms_profile_events_org_time
  ON hrms_migration_profile_events (organization_id, occurred_at);

CREATE TABLE hrms_scope_versions (
  organization_id text PRIMARY KEY REFERENCES organizations (id) ON DELETE RESTRICT,
  scope_revision bigint NOT NULL DEFAULT 1,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT chk_hrms_scope_revision CHECK (scope_revision > 0)
);

CREATE OR REPLACE FUNCTION app.hrms_profile_modes_json(profile hrms_migration_profiles)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT jsonb_build_object(
    'workforceReadMode', (profile).workforce_read_mode,
    'workforceWriteMode', (profile).workforce_write_mode,
    'historyMode', (profile).history_mode,
    'hierarchyReadMode', (profile).hierarchy_read_mode,
    'hierarchyWriteMode', (profile).hierarchy_write_mode,
    'attendanceReadMode', (profile).attendance_read_mode,
    'attendanceWriteMode', (profile).attendance_write_mode,
    'leaveReadMode', (profile).leave_read_mode,
    'leaveWriteMode', (profile).leave_write_mode,
    'sensitiveReadMode', (profile).sensitive_read_mode,
    'sensitiveWriteMode', (profile).sensitive_write_mode
  )
$function$;

CREATE OR REPLACE FUNCTION app.enforce_hrms_profile_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_state integer;
  new_state integer;
  sensitive_changed boolean;
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'HRMS_PROFILE_ORGANIZATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.profile_revision <> OLD.profile_revision + 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_REVISION_MUST_INCREMENT_BY_ONE' USING ERRCODE = '40001';
  END IF;
  IF NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'HRMS_PROFILE_CHANGED_AT_REGRESSION' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_sensitive_adapter_version < OLD.minimum_sensitive_adapter_version THEN
    RAISE EXCEPTION 'HRMS_PROFILE_ADAPTER_VERSION_REGRESSION' USING ERRCODE = '23514';
  END IF;
  IF OLD.sensitive_plaintext_writes_retired_at IS NOT NULL
    AND NEW.sensitive_plaintext_writes_retired_at IS DISTINCT FROM OLD.sensitive_plaintext_writes_retired_at THEN
    RAISE EXCEPTION 'HRMS_PROFILE_SENSITIVE_LATCH_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.sensitive_write_mode = 'LEGACY'
    AND NEW.sensitive_write_mode <> 'LEGACY'
    AND NEW.sensitive_plaintext_writes_retired_at IS NULL THEN
    RAISE EXCEPTION 'HRMS_PROFILE_SENSITIVE_LATCH_REQUIRED' USING ERRCODE = '23514';
  END IF;

  old_state := CASE
    WHEN (OLD.workforce_read_mode, OLD.workforce_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (OLD.workforce_read_mode, OLD.workforce_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (OLD.workforce_read_mode, OLD.workforce_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  new_state := CASE
    WHEN (NEW.workforce_read_mode, NEW.workforce_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (NEW.workforce_read_mode, NEW.workforce_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (NEW.workforce_read_mode, NEW.workforce_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  IF abs(new_state - old_state) > 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_WORKFORCE_TRANSITION_SKIPPED' USING ERRCODE = '23514';
  END IF;

  old_state := CASE OLD.history_mode WHEN 'LEGACY' THEN 0 WHEN 'DUAL' THEN 1 ELSE 2 END;
  new_state := CASE NEW.history_mode WHEN 'LEGACY' THEN 0 WHEN 'DUAL' THEN 1 ELSE 2 END;
  IF abs(new_state - old_state) > 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_HISTORY_TRANSITION_SKIPPED' USING ERRCODE = '23514';
  END IF;

  old_state := CASE
    WHEN (OLD.hierarchy_read_mode, OLD.hierarchy_write_mode) = ('ADJACENCY', 'LEGACY_ADAPTER') THEN 0
    WHEN (OLD.hierarchy_read_mode, OLD.hierarchy_write_mode) = ('SHADOW_CLOSURE', 'LOCKED_COMMAND') THEN 1
    ELSE 2
  END;
  new_state := CASE
    WHEN (NEW.hierarchy_read_mode, NEW.hierarchy_write_mode) = ('ADJACENCY', 'LEGACY_ADAPTER') THEN 0
    WHEN (NEW.hierarchy_read_mode, NEW.hierarchy_write_mode) = ('SHADOW_CLOSURE', 'LOCKED_COMMAND') THEN 1
    ELSE 2
  END;
  IF abs(new_state - old_state) > 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_HIERARCHY_TRANSITION_SKIPPED' USING ERRCODE = '23514';
  END IF;

  old_state := CASE
    WHEN (OLD.attendance_read_mode, OLD.attendance_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (OLD.attendance_read_mode, OLD.attendance_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (OLD.attendance_read_mode, OLD.attendance_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  new_state := CASE
    WHEN (NEW.attendance_read_mode, NEW.attendance_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (NEW.attendance_read_mode, NEW.attendance_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (NEW.attendance_read_mode, NEW.attendance_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  IF abs(new_state - old_state) > 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_ATTENDANCE_TRANSITION_SKIPPED' USING ERRCODE = '23514';
  END IF;

  old_state := CASE
    WHEN (OLD.leave_read_mode, OLD.leave_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (OLD.leave_read_mode, OLD.leave_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (OLD.leave_read_mode, OLD.leave_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  new_state := CASE
    WHEN (NEW.leave_read_mode, NEW.leave_write_mode) = ('LEGACY', 'LEGACY') THEN 0
    WHEN (NEW.leave_read_mode, NEW.leave_write_mode) = ('LEGACY', 'DUAL') THEN 1
    WHEN (NEW.leave_read_mode, NEW.leave_write_mode) = ('SHADOW', 'DUAL') THEN 2
    ELSE 3
  END;
  IF abs(new_state - old_state) > 1 THEN
    RAISE EXCEPTION 'HRMS_PROFILE_LEAVE_TRANSITION_SKIPPED' USING ERRCODE = '23514';
  END IF;

  sensitive_changed := (OLD.sensitive_read_mode, OLD.sensitive_write_mode)
    IS DISTINCT FROM (NEW.sensitive_read_mode, NEW.sensitive_write_mode);
  IF sensitive_changed AND NOT (
    ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('LEGACY_ADAPTER', 'LEGACY')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) = ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED'))
    OR ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) = ('SHADOW_ENCRYPTED', 'DUAL_ENCRYPTED'))
    OR ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('SHADOW_ENCRYPTED', 'DUAL_ENCRYPTED')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) IN (
        ('LEGACY_ADAPTER', 'DUAL_ENCRYPTED'),
        ('ENCRYPTED', 'ENCRYPTED')
      ))
    OR ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('ENCRYPTED', 'ENCRYPTED')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) = ('SHADOW_ENCRYPTED', 'ENCRYPTED'))
    OR ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('SHADOW_ENCRYPTED', 'ENCRYPTED')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) IN (
        ('ENCRYPTED', 'ENCRYPTED'),
        ('LEGACY_ADAPTER', 'ENCRYPTED')
      ))
    OR ((OLD.sensitive_read_mode, OLD.sensitive_write_mode) = ('LEGACY_ADAPTER', 'ENCRYPTED')
      AND (NEW.sensitive_read_mode, NEW.sensitive_write_mode) = ('SHADOW_ENCRYPTED', 'ENCRYPTED'))
  ) THEN
    RAISE EXCEPTION 'HRMS_PROFILE_SENSITIVE_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF ROW(
    NEW.workforce_read_mode,
    NEW.workforce_write_mode,
    NEW.history_mode,
    NEW.hierarchy_read_mode,
    NEW.hierarchy_write_mode,
    NEW.attendance_read_mode,
    NEW.attendance_write_mode,
    NEW.leave_read_mode,
    NEW.leave_write_mode,
    NEW.sensitive_read_mode,
    NEW.sensitive_write_mode,
    NEW.minimum_sensitive_adapter_version,
    NEW.sensitive_plaintext_writes_retired_at,
    NEW.rollback_deadline
  ) IS NOT DISTINCT FROM ROW(
    OLD.workforce_read_mode,
    OLD.workforce_write_mode,
    OLD.history_mode,
    OLD.hierarchy_read_mode,
    OLD.hierarchy_write_mode,
    OLD.attendance_read_mode,
    OLD.attendance_write_mode,
    OLD.leave_read_mode,
    OLD.leave_write_mode,
    OLD.sensitive_read_mode,
    OLD.sensitive_write_mode,
    OLD.minimum_sensitive_adapter_version,
    OLD.sensitive_plaintext_writes_retired_at,
    OLD.rollback_deadline
  ) THEN
    RAISE EXCEPTION 'HRMS_PROFILE_EMPTY_REVISION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.verify_hrms_profile_event_coupling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  profile hrms_migration_profiles%ROWTYPE;
  event hrms_migration_profile_events%ROWTYPE;
  expected_before jsonb;
BEGIN
  IF TG_TABLE_NAME = 'hrms_migration_profiles' THEN
    SELECT * INTO event
    FROM hrms_migration_profile_events
    WHERE organization_id = NEW.organization_id
      AND profile_revision = NEW.profile_revision;
    IF NOT FOUND
      OR event.after_modes <> app.hrms_profile_modes_json(NEW)
      OR event.approved_by_platform_user_id <> NEW.changed_by_platform_user_id THEN
      RAISE EXCEPTION 'HRMS_PROFILE_EVENT_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO profile
    FROM hrms_migration_profiles
    WHERE organization_id = NEW.organization_id;
    IF NOT FOUND
      OR profile.profile_revision <> NEW.profile_revision
      OR app.hrms_profile_modes_json(profile) <> NEW.after_modes
      OR profile.changed_by_platform_user_id <> NEW.approved_by_platform_user_id THEN
      RAISE EXCEPTION 'HRMS_PROFILE_EVENT_PROFILE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW.profile_revision = 2 THEN
      expected_before := jsonb_build_object(
        'workforceReadMode', 'LEGACY',
        'workforceWriteMode', 'LEGACY',
        'historyMode', 'LEGACY',
        'hierarchyReadMode', 'ADJACENCY',
        'hierarchyWriteMode', 'LEGACY_ADAPTER',
        'attendanceReadMode', 'LEGACY',
        'attendanceWriteMode', 'LEGACY',
        'leaveReadMode', 'LEGACY',
        'leaveWriteMode', 'LEGACY',
        'sensitiveReadMode', 'LEGACY_ADAPTER',
        'sensitiveWriteMode', 'LEGACY'
      );
    ELSE
      SELECT after_modes INTO expected_before
      FROM hrms_migration_profile_events
      WHERE organization_id = NEW.organization_id
        AND profile_revision = NEW.profile_revision - 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'HRMS_PROFILE_PREVIOUS_EVENT_MISSING' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.before_modes <> expected_before THEN
      RAISE EXCEPTION 'HRMS_PROFILE_EVENT_BEFORE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_hrms_scope_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.organization_id <> OLD.organization_id
    OR NEW.scope_revision <> OLD.scope_revision + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'HRMS_SCOPE_REVISION_INVALID' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER enforce_hrms_profile_transition
  BEFORE UPDATE ON hrms_migration_profiles
  FOR EACH ROW EXECUTE FUNCTION app.enforce_hrms_profile_transition();
CREATE CONSTRAINT TRIGGER verify_hrms_profile_update_event
  AFTER UPDATE ON hrms_migration_profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hrms_profile_event_coupling();
CREATE CONSTRAINT TRIGGER verify_hrms_profile_event_update
  AFTER INSERT ON hrms_migration_profile_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hrms_profile_event_coupling();
CREATE TRIGGER reject_hrms_profile_event_mutation
  BEFORE UPDATE OR DELETE ON hrms_migration_profile_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_profile_event_truncate
  BEFORE TRUNCATE ON hrms_migration_profile_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_profile_delete
  BEFORE DELETE ON hrms_migration_profiles
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_profile_truncate
  BEFORE TRUNCATE ON hrms_migration_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER enforce_hrms_scope_revision
  BEFORE UPDATE ON hrms_scope_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_hrms_scope_revision();
CREATE TRIGGER reject_hrms_scope_delete
  BEFORE DELETE ON hrms_scope_versions
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_scope_truncate
  BEFORE TRUNCATE ON hrms_scope_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();

INSERT INTO hrms_migration_profiles (organization_id)
SELECT id
FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO hrms_scope_versions (organization_id)
SELECT id
FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.seed_hrms_profile_for_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO hrms_migration_profiles (organization_id) VALUES (NEW.id);
  INSERT INTO hrms_scope_versions (organization_id) VALUES (NEW.id);
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.seed_hrms_profile_for_organization() FROM PUBLIC;

CREATE TRIGGER seed_hrms_profile_for_organization
  AFTER INSERT ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.seed_hrms_profile_for_organization();

CREATE TABLE hr_person_legacy_map (
  org_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  hr_person_id integer NOT NULL,
  organization_person_id text NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_by_membership_id integer NOT NULL,
  updated_by_membership_id integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_person_legacy_map PRIMARY KEY (org_id, hr_person_id),
  CONSTRAINT uniq_hr_person_legacy_map_org_person UNIQUE (org_id, organization_person_id),
  CONSTRAINT uniq_hr_person_legacy_map_chain UNIQUE (org_id, hr_person_id, organization_person_id),
  CONSTRAINT fk_hr_person_legacy_map_hr_person FOREIGN KEY (org_id, hr_person_id)
    REFERENCES hr_people (org_id, id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_person_legacy_map_org_person FOREIGN KEY (org_id, organization_person_id)
    REFERENCES organization_people (organization_id, organization_person_id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_person_legacy_map_created_actor FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members (org_id, id) MATCH FULL ON DELETE RESTRICT,
  CONSTRAINT fk_hr_person_legacy_map_updated_actor FOREIGN KEY (org_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id) MATCH FULL ON DELETE RESTRICT,
  CONSTRAINT chk_hr_person_legacy_map_row_version CHECK (row_version > 0)
);

CREATE INDEX idx_hr_person_legacy_map_created_actor
  ON hr_person_legacy_map (org_id, created_by_membership_id);
CREATE INDEX idx_hr_person_legacy_map_updated_actor
  ON hr_person_legacy_map (org_id, updated_by_membership_id);

CREATE TABLE hr_employment_legacy_map (
  org_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  hr_employment_id integer NOT NULL,
  hr_person_id integer NOT NULL,
  organization_person_id text NOT NULL,
  worker_id text NOT NULL,
  worker_engagement_id text NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_by_membership_id integer NOT NULL,
  updated_by_membership_id integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_employment_legacy_map PRIMARY KEY (org_id, hr_employment_id),
  CONSTRAINT uniq_hr_employment_legacy_map_engagement UNIQUE (org_id, worker_engagement_id),
  CONSTRAINT fk_hr_employment_legacy_map_hr_employment FOREIGN KEY (org_id, hr_employment_id, hr_person_id)
    REFERENCES hr_employments (org_id, id, person_id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_employment_legacy_map_person_map FOREIGN KEY (org_id, hr_person_id, organization_person_id)
    REFERENCES hr_person_legacy_map (org_id, hr_person_id, organization_person_id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_employment_legacy_map_worker FOREIGN KEY (org_id, organization_person_id, worker_id)
    REFERENCES workers (organization_id, organization_person_id, worker_id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_employment_legacy_map_engagement FOREIGN KEY (org_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id) MATCH FULL ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_hr_employment_legacy_map_created_actor FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members (org_id, id) MATCH FULL ON DELETE RESTRICT,
  CONSTRAINT fk_hr_employment_legacy_map_updated_actor FOREIGN KEY (org_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id) MATCH FULL ON DELETE RESTRICT,
  CONSTRAINT chk_hr_employment_legacy_map_row_version CHECK (row_version > 0)
);

CREATE INDEX idx_hr_employment_legacy_map_person
  ON hr_employment_legacy_map (org_id, hr_person_id);
CREATE INDEX idx_hr_employment_legacy_map_worker
  ON hr_employment_legacy_map (org_id, worker_id);
CREATE INDEX idx_hr_employment_legacy_map_created_actor
  ON hr_employment_legacy_map (org_id, created_by_membership_id);
CREATE INDEX idx_hr_employment_legacy_map_updated_actor
  ON hr_employment_legacy_map (org_id, updated_by_membership_id);

CREATE TABLE hr_workforce_reconciliation_items (
  reconciliation_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  batch_id text NOT NULL,
  source_fingerprint text NOT NULL,
  issue_kind text NOT NULL,
  field_code text,
  status text NOT NULL DEFAULT 'OPEN',
  source_membership_id integer,
  source_user_id text REFERENCES users (id) ON DELETE RESTRICT,
  source_organization_person_id text,
  source_worker_id text,
  source_worker_engagement_id text,
  source_hr_person_id integer,
  source_hr_employment_id integer,
  resolved_organization_person_id text,
  resolved_worker_id text,
  resolved_worker_engagement_id text,
  classification text,
  reason_code text,
  source_snapshot_hash text NOT NULL,
  resolution_hash text,
  manifest_hash text,
  prepared_by_membership_id integer,
  prepared_at timestamp with time zone,
  approved_by_membership_id integer,
  approved_at timestamp with time zone,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT uniq_hr_workforce_reconciliation_org_id UNIQUE (org_id, reconciliation_item_id),
  CONSTRAINT fk_hr_workforce_reconciliation_source_membership FOREIGN KEY (org_id, source_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_source_person FOREIGN KEY (org_id, source_organization_person_id)
    REFERENCES organization_people (organization_id, organization_person_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_source_worker FOREIGN KEY (org_id, source_organization_person_id, source_worker_id)
    REFERENCES workers (organization_id, organization_person_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_source_engagement FOREIGN KEY (org_id, source_worker_id, source_worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_source_hr_person FOREIGN KEY (org_id, source_hr_person_id)
    REFERENCES hr_people (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_source_hr_employment FOREIGN KEY (org_id, source_hr_employment_id, source_hr_person_id)
    REFERENCES hr_employments (org_id, id, person_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_resolved_person FOREIGN KEY (org_id, resolved_organization_person_id)
    REFERENCES organization_people (organization_id, organization_person_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_resolved_worker FOREIGN KEY (org_id, resolved_organization_person_id, resolved_worker_id)
    REFERENCES workers (organization_id, organization_person_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_resolved_engagement FOREIGN KEY (org_id, resolved_worker_id, resolved_worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_id, worker_engagement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_prepared_actor FOREIGN KEY (org_id, prepared_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_hr_workforce_reconciliation_approved_actor FOREIGN KEY (org_id, approved_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_hr_workforce_reconciliation_status CHECK (status IN ('OPEN', 'PREPARED', 'APPROVED')),
  CONSTRAINT chk_hr_workforce_reconciliation_issue_kind CHECK (
    issue_kind IN ('CLASSIFICATION', 'IDENTITY_CONFLICT', 'FIELD_MISMATCH', 'PII_ATTRIBUTION')
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_classification CHECK (
    classification IS NULL
    OR classification IN ('ACCESS_ONLY', 'PERSON_ONLY', 'WORKFORCE_SUBJECT', 'LEGACY_COMPATIBILITY_SUBJECT')
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_nonblank_source CHECK (
    btrim(batch_id) <> ''
    AND btrim(source_fingerprint) <> ''
    AND btrim(source_snapshot_hash) <> ''
    AND (field_code IS NULL OR btrim(field_code) <> '')
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_nonblank_resolution CHECK (
    (reason_code IS NULL OR btrim(reason_code) <> '')
    AND (resolution_hash IS NULL OR btrim(resolution_hash) <> '')
    AND (manifest_hash IS NULL OR btrim(manifest_hash) <> '')
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_has_source CHECK (
    num_nonnulls(source_membership_id, source_user_id, source_organization_person_id, source_hr_person_id) > 0
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_source_chain CHECK (
    (source_worker_id IS NULL OR source_organization_person_id IS NOT NULL)
    AND (source_worker_engagement_id IS NULL OR source_worker_id IS NOT NULL)
    AND (source_hr_employment_id IS NULL OR source_hr_person_id IS NOT NULL)
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_resolution_chain CHECK (
    (resolved_worker_id IS NULL OR resolved_organization_person_id IS NOT NULL)
    AND (resolved_worker_engagement_id IS NULL OR resolved_worker_id IS NOT NULL)
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_approved_shape CHECK (
    status <> 'APPROVED'
    OR (
      classification = 'ACCESS_ONLY'
      AND resolved_organization_person_id IS NULL
      AND resolved_worker_id IS NULL
      AND resolved_worker_engagement_id IS NULL
    )
    OR (
      classification = 'PERSON_ONLY'
      AND resolved_organization_person_id IS NOT NULL
      AND resolved_worker_id IS NULL
      AND resolved_worker_engagement_id IS NULL
    )
    OR (
      classification IN ('WORKFORCE_SUBJECT', 'LEGACY_COMPATIBILITY_SUBJECT')
      AND resolved_organization_person_id IS NOT NULL
      AND resolved_worker_id IS NOT NULL
      AND resolved_worker_engagement_id IS NOT NULL
    )
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_distinct_reviewers CHECK (
    prepared_by_membership_id IS NULL
    OR approved_by_membership_id IS NULL
    OR prepared_by_membership_id <> approved_by_membership_id
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_review_state CHECK (
    (
      status = 'OPEN'
      AND classification IS NULL
      AND reason_code IS NULL
      AND resolution_hash IS NULL
      AND manifest_hash IS NULL
      AND prepared_by_membership_id IS NULL
      AND prepared_at IS NULL
      AND approved_by_membership_id IS NULL
      AND approved_at IS NULL
    )
    OR (
      status = 'PREPARED'
      AND classification IS NOT NULL
      AND reason_code IS NOT NULL
      AND resolution_hash IS NOT NULL
      AND manifest_hash IS NULL
      AND prepared_by_membership_id IS NOT NULL
      AND prepared_at IS NOT NULL
      AND approved_by_membership_id IS NULL
      AND approved_at IS NULL
    )
    OR (
      status = 'APPROVED'
      AND classification IS NOT NULL
      AND reason_code IS NOT NULL
      AND resolution_hash IS NOT NULL
      AND manifest_hash IS NOT NULL
      AND prepared_by_membership_id IS NOT NULL
      AND prepared_at IS NOT NULL
      AND approved_by_membership_id IS NOT NULL
      AND approved_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_hr_workforce_reconciliation_row_version CHECK (row_version > 0)
);

CREATE UNIQUE INDEX uniq_hr_workforce_reconciliation_source
  ON hr_workforce_reconciliation_items (
    org_id,
    batch_id,
    source_fingerprint,
    issue_kind,
    coalesce(field_code, '')
  );
CREATE INDEX idx_hr_workforce_reconciliation_status
  ON hr_workforce_reconciliation_items (org_id, batch_id, status);
CREATE INDEX idx_hr_workforce_reconciliation_resolved_worker
  ON hr_workforce_reconciliation_items (org_id, resolved_worker_id);
CREATE INDEX idx_hr_workforce_reconciliation_prepared_actor
  ON hr_workforce_reconciliation_items (org_id, prepared_by_membership_id);
CREATE INDEX idx_hr_workforce_reconciliation_approved_actor
  ON hr_workforce_reconciliation_items (org_id, approved_by_membership_id);

CREATE OR REPLACE FUNCTION app.verify_hr_workforce_mapping()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_org text;
  affected_orgs text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    affected_orgs := ARRAY[NEW.org_id];
  ELSIF TG_OP = 'DELETE' THEN
    affected_orgs := ARRAY[OLD.org_id];
  ELSIF NEW.org_id = OLD.org_id THEN
    affected_orgs := ARRAY[NEW.org_id];
  ELSE
    affected_orgs := ARRAY[OLD.org_id, NEW.org_id];
  END IF;

  FOREACH affected_org IN ARRAY affected_orgs
  LOOP
    IF EXISTS (
      SELECT 1
      FROM hr_people person
      WHERE person.org_id = affected_org
        AND person.organization_person_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM hr_person_legacy_map person_map
          WHERE person_map.org_id = person.org_id
            AND person_map.hr_person_id = person.id
            AND person_map.organization_person_id = person.organization_person_id
        )
    ) OR EXISTS (
      SELECT 1
      FROM hr_person_legacy_map person_map
      JOIN hr_people person
        ON person.org_id = person_map.org_id
        AND person.id = person_map.hr_person_id
      WHERE person_map.org_id = affected_org
        AND person.organization_person_id IS DISTINCT FROM person_map.organization_person_id
    ) THEN
      RAISE EXCEPTION 'HRMS_PERSON_MAP_PROJECTION_MISMATCH' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM hr_employments employment
      WHERE employment.org_id = affected_org
        AND (employment.worker_id IS NOT NULL OR employment.worker_engagement_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1
          FROM hr_employment_legacy_map employment_map
          WHERE employment_map.org_id = employment.org_id
            AND employment_map.hr_employment_id = employment.id
            AND employment_map.hr_person_id = employment.person_id
            AND employment_map.worker_id = employment.worker_id
            AND employment_map.worker_engagement_id = employment.worker_engagement_id
        )
    ) OR EXISTS (
      SELECT 1
      FROM hr_employment_legacy_map employment_map
      JOIN hr_employments employment
        ON employment.org_id = employment_map.org_id
        AND employment.id = employment_map.hr_employment_id
      WHERE employment_map.org_id = affected_org
        AND (
          employment.person_id IS DISTINCT FROM employment_map.hr_person_id
          OR employment.worker_id IS DISTINCT FROM employment_map.worker_id
          OR employment.worker_engagement_id IS DISTINCT FROM employment_map.worker_engagement_id
        )
    ) THEN
      RAISE EXCEPTION 'HRMS_EMPLOYMENT_MAP_PROJECTION_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER verify_hr_people_workforce_mapping
  AFTER INSERT OR UPDATE OR DELETE ON hr_people
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hr_workforce_mapping();
CREATE CONSTRAINT TRIGGER verify_hr_person_legacy_mapping
  AFTER INSERT OR UPDATE OR DELETE ON hr_person_legacy_map
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hr_workforce_mapping();
CREATE CONSTRAINT TRIGGER verify_hr_employments_workforce_mapping
  AFTER INSERT OR UPDATE OR DELETE ON hr_employments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hr_workforce_mapping();
CREATE CONSTRAINT TRIGGER verify_hr_employment_legacy_mapping
  AFTER INSERT OR UPDATE OR DELETE ON hr_employment_legacy_map
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_hr_workforce_mapping();

CREATE OR REPLACE FUNCTION app.enforce_hr_workforce_reconciliation_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'HRMS_RECONCILIATION_APPROVAL_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.org_id <> OLD.org_id
    OR NEW.reconciliation_item_id <> OLD.reconciliation_item_id
    OR NEW.batch_id <> OLD.batch_id
    OR NEW.source_fingerprint <> OLD.source_fingerprint
    OR NEW.issue_kind <> OLD.issue_kind
    OR NEW.field_code IS DISTINCT FROM OLD.field_code
    OR NEW.source_membership_id IS DISTINCT FROM OLD.source_membership_id
    OR NEW.source_user_id IS DISTINCT FROM OLD.source_user_id
    OR NEW.source_organization_person_id IS DISTINCT FROM OLD.source_organization_person_id
    OR NEW.source_worker_id IS DISTINCT FROM OLD.source_worker_id
    OR NEW.source_worker_engagement_id IS DISTINCT FROM OLD.source_worker_engagement_id
    OR NEW.source_hr_person_id IS DISTINCT FROM OLD.source_hr_person_id
    OR NEW.source_hr_employment_id IS DISTINCT FROM OLD.source_hr_employment_id
    OR NEW.source_snapshot_hash <> OLD.source_snapshot_hash
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'HRMS_RECONCILIATION_SOURCE_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'HRMS_RECONCILIATION_ROW_VERSION_INVALID' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status = 'PREPARED')
    OR (OLD.status = 'PREPARED' AND NEW.status IN ('OPEN', 'APPROVED'))
  ) THEN
    RAISE EXCEPTION 'HRMS_RECONCILIATION_TRANSITION_INVALID' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'PREPARED'
    AND NEW.status = 'APPROVED'
    AND ROW(
      NEW.resolved_organization_person_id,
      NEW.resolved_worker_id,
      NEW.resolved_worker_engagement_id,
      NEW.classification,
      NEW.reason_code,
      NEW.resolution_hash,
      NEW.prepared_by_membership_id,
      NEW.prepared_at
    ) IS DISTINCT FROM ROW(
      OLD.resolved_organization_person_id,
      OLD.resolved_worker_id,
      OLD.resolved_worker_engagement_id,
      OLD.classification,
      OLD.reason_code,
      OLD.resolution_hash,
      OLD.prepared_by_membership_id,
      OLD.prepared_at
    ) THEN
    RAISE EXCEPTION 'HRMS_RECONCILIATION_PREPARED_RESOLUTION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER enforce_hr_workforce_reconciliation_transition
  BEFORE UPDATE ON hr_workforce_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION app.enforce_hr_workforce_reconciliation_transition();
CREATE TRIGGER reject_hr_workforce_reconciliation_delete
  BEFORE DELETE ON hr_workforce_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hr_workforce_reconciliation_truncate
  BEFORE TRUNCATE ON hr_workforce_reconciliation_items
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();

ALTER TABLE hrms_migration_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrms_migration_profile_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrms_scope_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_person_legacy_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employment_legacy_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_workforce_reconciliation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON hrms_migration_profiles
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hrms_migration_profile_events
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hrms_scope_versions
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hr_person_legacy_map
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hr_employment_legacy_map
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hr_workforce_reconciliation_items
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

REVOKE ALL ON hrms_migration_profiles FROM PUBLIC;
REVOKE ALL ON hrms_migration_profile_events FROM PUBLIC;
REVOKE ALL ON hrms_scope_versions FROM PUBLIC;
REVOKE ALL ON hr_person_legacy_map FROM PUBLIC;
REVOKE ALL ON hr_employment_legacy_map FROM PUBLIC;
REVOKE ALL ON hr_workforce_reconciliation_items FROM PUBLIC;
REVOKE ALL ON SEQUENCE hr_workforce_reconciliation_items_reconciliation_item_id_seq FROM PUBLIC;
REVOKE ALL ON app.hrms_sql_bundle_operations FROM PUBLIC;

REVOKE ALL ON FUNCTION app.verify_hrms_profile_event_coupling() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.verify_hr_workforce_mapping() FROM PUBLIC;

DO $grants$
DECLARE
  application_role text := coalesce(nullif(current_setting('app.bootstrap_role', true), ''), 'streamline_app');
  execution_role text := coalesce(nullif(current_setting('app.hrms_migration_role', true), ''), 'streamline_hrms_migration');
BEGIN
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE hrms_migration_profiles, hrms_migration_profile_events, hrms_scope_versions, hr_person_legacy_map, hr_employment_legacy_map, hr_workforce_reconciliation_items FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE hr_workforce_reconciliation_items_reconciliation_item_id_seq FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE app.hrms_sql_bundle_operations FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION app.enforce_hrms_bundle_operation_transition() FROM %I',
    application_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', application_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id() TO %I', application_role);
  EXECUTE format(
    'GRANT SELECT (organization_id, profile_revision, changed_at) ON hrms_migration_profiles TO %I',
    application_role
  );
  EXECUTE format('GRANT SELECT ON hrms_scope_versions TO %I', application_role);

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE hrms_migration_profiles, hrms_migration_profile_events, hrms_scope_versions, hr_person_legacy_map, hr_employment_legacy_map, hr_workforce_reconciliation_items FROM %I',
    execution_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE hr_workforce_reconciliation_items_reconciliation_item_id_seq FROM %I',
    execution_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE app.hrms_sql_bundle_operations FROM %I',
    execution_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION app.enforce_hrms_bundle_operation_transition() FROM %I',
    execution_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', execution_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id() TO %I', execution_role);
  EXECUTE format('GRANT SELECT, UPDATE ON hrms_migration_profiles TO %I', execution_role);
  EXECUTE format('GRANT SELECT, INSERT ON hrms_migration_profile_events TO %I', execution_role);
  EXECUTE format('GRANT SELECT, UPDATE ON hrms_scope_versions TO %I', execution_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON hr_person_legacy_map, hr_employment_legacy_map, hr_workforce_reconciliation_items TO %I', execution_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE hr_workforce_reconciliation_items_reconciliation_item_id_seq TO %I', execution_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON app.hrms_sql_bundle_operations TO %I', execution_role);
END
$grants$;

DO $grant_assertions$
DECLARE
  application_role text := coalesce(nullif(current_setting('app.bootstrap_role', true), ''), 'streamline_app');
  execution_role text := coalesce(nullif(current_setting('app.hrms_migration_role', true), ''), 'streamline_hrms_migration');
  target record;
  attribute record;
  privilege_name text;
  application_expected boolean;
  execution_expected boolean;
  application_has_maintain boolean;
  execution_has_maintain boolean;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('hrms_migration_profiles'::regclass, ARRAY[]::text[], ARRAY['organization_id', 'profile_revision', 'changed_at']::text[], ARRAY['SELECT', 'UPDATE']::text[]),
      ('hrms_migration_profile_events'::regclass, ARRAY[]::text[], ARRAY[]::text[], ARRAY['SELECT', 'INSERT']::text[]),
      ('hrms_scope_versions'::regclass, ARRAY['SELECT']::text[], ARRAY[]::text[], ARRAY['SELECT', 'UPDATE']::text[]),
      ('hr_person_legacy_map'::regclass, ARRAY[]::text[], ARRAY[]::text[], ARRAY['SELECT', 'INSERT', 'UPDATE']::text[]),
      ('hr_employment_legacy_map'::regclass, ARRAY[]::text[], ARRAY[]::text[], ARRAY['SELECT', 'INSERT', 'UPDATE']::text[]),
      ('hr_workforce_reconciliation_items'::regclass, ARRAY[]::text[], ARRAY[]::text[], ARRAY['SELECT', 'INSERT', 'UPDATE']::text[]),
      ('app.hrms_sql_bundle_operations'::regclass, ARRAY[]::text[], ARRAY[]::text[], ARRAY['SELECT', 'INSERT', 'UPDATE']::text[])
    ) expected(
      relation_oid,
      application_table_privileges,
      application_select_columns,
      execution_table_privileges
    )
  LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      application_expected := privilege_name = ANY(target.application_table_privileges);
      execution_expected := privilege_name = ANY(target.execution_table_privileges);
      IF has_table_privilege(
        application_role,
        target.relation_oid,
        privilege_name
      ) IS DISTINCT FROM application_expected THEN
        RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_TABLE_PRIVILEGE_MISMATCH: % %', target.relation_oid, privilege_name
          USING ERRCODE = '42501';
      END IF;
      IF has_table_privilege(
        execution_role,
        target.relation_oid,
        privilege_name
      ) IS DISTINCT FROM execution_expected THEN
        RAISE EXCEPTION 'HRMS_EXECUTION_ROLE_TABLE_PRIVILEGE_MISMATCH: % %', target.relation_oid, privilege_name
          USING ERRCODE = '42501';
      END IF;
    END LOOP;

    FOR attribute IN
      SELECT attnum, attname
      FROM pg_attribute
      WHERE attrelid = target.relation_oid
        AND attnum > 0
        AND NOT attisdropped
    LOOP
      FOREACH privilege_name IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'REFERENCES'
      ]::text[]
      LOOP
        application_expected := privilege_name = ANY(target.application_table_privileges)
          OR (
            privilege_name = 'SELECT'
            AND attribute.attname = ANY(target.application_select_columns)
          );
        execution_expected := privilege_name = ANY(target.execution_table_privileges);
        IF has_column_privilege(
          application_role,
          target.relation_oid,
          attribute.attnum,
          privilege_name
        ) IS DISTINCT FROM application_expected THEN
          RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_COLUMN_PRIVILEGE_MISMATCH: % % %', target.relation_oid, attribute.attname, privilege_name
            USING ERRCODE = '42501';
        END IF;
        IF has_column_privilege(
          execution_role,
          target.relation_oid,
          attribute.attnum,
          privilege_name
        ) IS DISTINCT FROM execution_expected THEN
          RAISE EXCEPTION 'HRMS_EXECUTION_ROLE_COLUMN_PRIVILEGE_MISMATCH: % % %', target.relation_oid, attribute.attname, privilege_name
            USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END LOOP;

    application_has_maintain := false;
    execution_has_maintain := false;
    IF current_setting('server_version_num')::integer >= 170000 THEN
      EXECUTE
        'SELECT has_table_privilege($1::name, $2::oid, ''MAINTAIN''), has_table_privilege($3::name, $2::oid, ''MAINTAIN'')'
        INTO application_has_maintain, execution_has_maintain
        USING application_role, target.relation_oid::oid, execution_role;
    END IF;
    IF application_has_maintain OR execution_has_maintain THEN
      RAISE EXCEPTION 'HRMS_ROLE_MAINTAIN_PRIVILEGE_MISMATCH: %', target.relation_oid
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(
        (SELECT relacl FROM pg_class WHERE oid = target.relation_oid),
        '{}'::aclitem[]
      )) access
      WHERE access.grantee = 0
    ) OR EXISTS (
      SELECT 1
      FROM pg_attribute public_attribute
      CROSS JOIN LATERAL aclexplode(
        coalesce(public_attribute.attacl, '{}'::aclitem[])
      ) access
      WHERE public_attribute.attrelid = target.relation_oid
        AND public_attribute.attnum > 0
        AND NOT public_attribute.attisdropped
        AND access.grantee = 0
    ) THEN
      RAISE EXCEPTION 'HRMS_PUBLIC_RELATION_PRIVILEGE: %', target.relation_oid
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOREACH privilege_name IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE']::text[]
  LOOP
    IF has_sequence_privilege(
      application_role,
      'hr_workforce_reconciliation_items_reconciliation_item_id_seq',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_SEQUENCE_PRIVILEGE: %', privilege_name
        USING ERRCODE = '42501';
    END IF;
    execution_expected := privilege_name IN ('USAGE', 'SELECT');
    IF has_sequence_privilege(
      execution_role,
      'hr_workforce_reconciliation_items_reconciliation_item_id_seq',
      privilege_name
    ) IS DISTINCT FROM execution_expected THEN
      RAISE EXCEPTION 'HRMS_EXECUTION_ROLE_SEQUENCE_PRIVILEGE_MISMATCH: %', privilege_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_class sequence
    CROSS JOIN LATERAL aclexplode(
      coalesce(sequence.relacl, '{}'::aclitem[])
    ) access
    WHERE sequence.oid = 'hr_workforce_reconciliation_items_reconciliation_item_id_seq'::regclass
      AND access.grantee = 0
  ) THEN
    RAISE EXCEPTION 'HRMS_PUBLIC_SEQUENCE_PRIVILEGE'
      USING ERRCODE = '42501';
  END IF;
  IF has_function_privilege(
    application_role,
    'app.enforce_hrms_bundle_operation_transition()',
    'EXECUTE'
  ) OR has_function_privilege(
    execution_role,
    'app.enforce_hrms_bundle_operation_transition()',
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(
      routine.proacl,
      acldefault('f', routine.proowner)
    )) access
    WHERE routine.oid = 'app.enforce_hrms_bundle_operation_transition()'::regprocedure
      AND access.grantee <> routine.proowner
  ) OR (
    SELECT pg_get_userbyid(routine.proowner) <> current_user
    FROM pg_proc routine
    WHERE routine.oid = 'app.enforce_hrms_bundle_operation_transition()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_FUNCTION_ACL_MISMATCH'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'hrms_migration_profiles',
      'hrms_migration_profile_events',
      'hrms_scope_versions',
      'hr_person_legacy_map',
      'hr_employment_legacy_map',
      'hr_workforce_reconciliation_items'
    ]::text[]) target(table_name)
    JOIN pg_class relation ON relation.oid = target.table_name::regclass
    WHERE NOT relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'HRMS_RLS_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
END
$grant_assertions$;

DO $complete_operation$
DECLARE
  affected_rows integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations operation
    WHERE operation.file_name = '0000_hrms_profiles_workforce.sql'
      AND operation.database_name = current_database()
      AND operation.state IN ('RUNNING', 'VERIFYING', 'COMPLETE')
      AND operation.operation_id <> btrim(current_setting('app.hrms_bundle_operation_id'))
  ) THEN
    RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_COMPLETE_AMBIGUOUS'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO app.hrms_sql_bundle_operations (
    operation_id,
    bundle_id,
    file_name,
    sql_hash,
    manifest_hash,
    root_migration_hash,
    state,
    attempts,
    database_name,
    database_role,
    server_version_num,
    started_at,
    completed_at,
    last_error
  )
  VALUES (
    btrim(current_setting('app.hrms_bundle_operation_id')),
    btrim(current_setting('app.hrms_bundle_id')),
    btrim(current_setting('app.hrms_bundle_file_name')),
    btrim(current_setting('app.hrms_bundle_sql_hash')),
    btrim(current_setting('app.hrms_bundle_manifest_hash')),
    btrim(current_setting('app.hrms_bundle_root_migration_hash')),
    'COMPLETE',
    1,
    current_database(),
    current_user,
    current_setting('server_version_num')::integer,
    transaction_timestamp(),
    clock_timestamp(),
    NULL
  )
  ON CONFLICT (operation_id) DO NOTHING;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows = 0 THEN
    UPDATE app.hrms_sql_bundle_operations operation
    SET state = 'RUNNING',
      attempts = operation.attempts + 1,
      started_at = greatest(clock_timestamp(), operation.started_at + interval '1 microsecond'),
      completed_at = NULL,
      last_error = NULL
    WHERE operation.operation_id = btrim(current_setting('app.hrms_bundle_operation_id'))
      AND operation.bundle_id = btrim(current_setting('app.hrms_bundle_id'))
      AND operation.file_name = btrim(current_setting('app.hrms_bundle_file_name'))
      AND operation.sql_hash = btrim(current_setting('app.hrms_bundle_sql_hash'))
      AND operation.manifest_hash = btrim(current_setting('app.hrms_bundle_manifest_hash'))
      AND operation.root_migration_hash = btrim(current_setting('app.hrms_bundle_root_migration_hash'))
      AND operation.database_name = current_database()
      AND operation.database_role = current_user
      AND operation.server_version_num = current_setting('server_version_num')::integer
      AND operation.state = 'ROLLED_BACK';
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
      RAISE EXCEPTION 'HRMS_BUNDLE_OPERATION_REAPPLY_TARGET_INVALID'
        USING ERRCODE = '55000';
    END IF;

    UPDATE app.hrms_sql_bundle_operations
    SET state = 'VERIFYING'
    WHERE operation_id = btrim(current_setting('app.hrms_bundle_operation_id'))
      AND state = 'RUNNING';
    UPDATE app.hrms_sql_bundle_operations
    SET state = 'COMPLETE', completed_at = clock_timestamp()
    WHERE operation_id = btrim(current_setting('app.hrms_bundle_operation_id'))
      AND state = 'VERIFYING';
  END IF;
END
$complete_operation$;

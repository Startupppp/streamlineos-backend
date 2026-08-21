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
  requested_bundle_id text := nullif(btrim(current_setting('app.hrms_bundle_id', true)), '');
  bundle_file_name text := nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '');
  bundle_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '');
  bundle_dependency_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_dependency_sql_hash', true)), '');
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
        'verify_workforce_org_unit_kinds',
        'lock_worker_reporting_line_tenant',
        'verify_worker_reporting_line_cycles',
        'enforce_workforce_period_revision',
        'verify_worker_engagement_state_chain',
        'verify_worker_engagement_state_projection'
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
    OR requested_bundle_id IS NULL
    OR bundle_file_name IS NULL
    OR bundle_sql_hash IS NULL
    OR bundle_dependency_sql_hash IS NULL
    OR bundle_manifest_hash IS NULL
    OR bundle_root_migration_hash IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_METADATA_MISSING' USING ERRCODE = '22023';
  END IF;
  IF bundle_file_name <> '0001_hrms_effective_history.sql' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF bundle_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_dependency_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_manifest_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_root_migration_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('hrms_migration_profiles') IS NULL
    OR to_regclass('hrms_scope_versions') IS NULL
    OR to_regclass('app.hrms_sql_bundle_operations') IS NULL THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_REQUIRES_0000' USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations current_operation
    WHERE current_operation.operation_id = bundle_operation_id
      AND current_operation.bundle_id = requested_bundle_id
      AND current_operation.file_name = bundle_file_name
      AND current_operation.sql_hash = bundle_sql_hash
      AND current_operation.manifest_hash = bundle_manifest_hash
      AND current_operation.root_migration_hash = bundle_root_migration_hash
      AND current_operation.state = 'RUNNING'
      AND current_operation.database_name = current_database()
      AND current_operation.database_role = current_user
      AND current_operation.server_version_num = current_setting('server_version_num')::integer
  ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_CURRENT_OPERATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations prior_operation
    WHERE prior_operation.bundle_id = requested_bundle_id
      AND prior_operation.file_name = '0000_hrms_profiles_workforce.sql'
      AND prior_operation.sql_hash = bundle_dependency_sql_hash
      AND prior_operation.root_migration_hash = bundle_root_migration_hash
      AND prior_operation.state = 'COMPLETE'
      AND prior_operation.database_name = current_database()
      AND prior_operation.database_role = current_user
      AND prior_operation.server_version_num = current_setting('server_version_num')::integer
  ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_REQUIRES_COMPLETE_0000_OPERATION' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
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
      OR sensitive_plaintext_writes_retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_REQUIRES_LEGACY_PROFILES' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'worker_engagements'::regclass
      AND conname = 'excl_worker_engagements_overlap'
  ) THEN
    RAISE EXCEPTION 'HRMS_WORKER_ENGAGEMENT_OVERLAP_CONSTRAINT_MISSING' USING ERRCODE = '42704';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'HRMS_BTREE_GIST_EXTENSION_MISSING' USING ERRCODE = '42704';
  END IF;
END
$preflight$;

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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_units_org_id
  ON org_units (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_job_roles_org_id
  ON hr_job_roles (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_job_levels_org_id
  ON hr_job_levels (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shift_templates_org_id
  ON shift_templates (org_id, id);

DO $candidate_keys$
DECLARE
  candidate record;
BEGIN
  FOR candidate IN
    SELECT * FROM (VALUES
      ('org_units', 'uniq_org_units_org_id'),
      ('hr_job_roles', 'uniq_hr_job_roles_org_id'),
      ('hr_job_levels', 'uniq_hr_job_levels_org_id'),
      ('shift_templates', 'uniq_shift_templates_org_id')
    ) AS candidates(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = to_regclass(candidate.table_name)
        AND conname = candidate.constraint_name
    ) THEN
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

ALTER TABLE worker_engagements
  ADD COLUMN IF NOT EXISTS state_reason text,
  ADD COLUMN IF NOT EXISTS last_state_event_id bigint;

CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_manager
  ON worker_engagements (organization_id, manager_engagement_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_business_unit
  ON worker_engagements (organization_id, business_unit_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_branch
  ON worker_engagements (organization_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_department
  ON worker_engagements (organization_id, department_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_team
  ON worker_engagements (organization_id, team_id);
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org_location
  ON worker_engagements (organization_id, location_id);

DO $existing_constraints$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('worker_engagements', 'chk_worker_engagements_dates', 'CHECK (ends_on IS NULL OR ends_on > starts_on) NOT VALID'),
      ('worker_engagements', 'chk_worker_engagements_worker_type', 'CHECK (worker_type IN (''FULL_TIME'', ''PART_TIME'', ''CONTRACTOR'', ''CONSULTANT'', ''INTERN'', ''TEMPORARY'', ''AGENCY'', ''FREELANCER'')) NOT VALID'),
      ('worker_engagements', 'chk_worker_engagements_state_reason', 'CHECK (state_reason IS NULL OR btrim(state_reason) <> '''') NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_worker_restrict_p1', 'FOREIGN KEY (organization_id, worker_id) REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_manager', 'FOREIGN KEY (organization_id, manager_engagement_id) REFERENCES worker_engagements (organization_id, worker_engagement_id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_business_unit', 'FOREIGN KEY (organization_id, business_unit_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_branch', 'FOREIGN KEY (organization_id, branch_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_department', 'FOREIGN KEY (organization_id, department_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_team', 'FOREIGN KEY (organization_id, team_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_location', 'FOREIGN KEY (organization_id, location_id) REFERENCES org_units (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_job_role', 'FOREIGN KEY (organization_id, job_role_id) REFERENCES hr_job_roles (org_id, id) ON DELETE RESTRICT NOT VALID'),
      ('worker_engagements', 'fk_worker_engagements_org_job_level', 'FOREIGN KEY (organization_id, job_level_id) REFERENCES hr_job_levels (org_id, id) ON DELETE RESTRICT NOT VALID')
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

CREATE TABLE worker_assignment_periods (
  assignment_period_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  worker_engagement_id text NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL DEFAULT 'infinity'::date,
  is_primary boolean NOT NULL DEFAULT true,
  business_unit_id text,
  branch_id text,
  department_id text,
  team_id text,
  location_id text,
  cost_center_id text,
  job_role_id integer,
  job_level_id integer,
  employment_type text,
  designation text,
  schedule_id integer,
  row_version integer NOT NULL DEFAULT 1,
  created_by_membership_id integer,
  updated_by_membership_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT uniq_worker_assignment_periods_org_id UNIQUE (organization_id, assignment_period_id),
  CONSTRAINT fk_worker_assignment_periods_engagement FOREIGN KEY (organization_id, worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_engagement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_business_unit FOREIGN KEY (organization_id, business_unit_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_branch FOREIGN KEY (organization_id, branch_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_department FOREIGN KEY (organization_id, department_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_team FOREIGN KEY (organization_id, team_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_location FOREIGN KEY (organization_id, location_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_cost_center FOREIGN KEY (organization_id, cost_center_id)
    REFERENCES org_units (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_job_role FOREIGN KEY (organization_id, job_role_id)
    REFERENCES hr_job_roles (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_job_level FOREIGN KEY (organization_id, job_level_id)
    REFERENCES hr_job_levels (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_schedule FOREIGN KEY (organization_id, schedule_id)
    REFERENCES shift_templates (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_created_actor FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_assignment_periods_updated_actor FOREIGN KEY (organization_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_worker_assignment_periods_dates CHECK (valid_from < valid_to),
  CONSTRAINT chk_worker_assignment_periods_employment_type CHECK (
    employment_type IS NULL
    OR employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'TEMPORARY', 'AGENCY', 'FREELANCER')
  ),
  CONSTRAINT chk_worker_assignment_periods_row_version CHECK (row_version > 0),
  CONSTRAINT excl_worker_assignment_periods_primary_overlap EXCLUDE USING gist (
    organization_id WITH =,
    worker_engagement_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (is_primary = true)
);

CREATE INDEX idx_worker_assignment_periods_engagement
  ON worker_assignment_periods (organization_id, worker_engagement_id, valid_from);
CREATE INDEX idx_worker_assignment_periods_business_unit
  ON worker_assignment_periods (organization_id, business_unit_id);
CREATE INDEX idx_worker_assignment_periods_branch
  ON worker_assignment_periods (organization_id, branch_id);
CREATE INDEX idx_worker_assignment_periods_department
  ON worker_assignment_periods (organization_id, department_id);
CREATE INDEX idx_worker_assignment_periods_team
  ON worker_assignment_periods (organization_id, team_id);
CREATE INDEX idx_worker_assignment_periods_location
  ON worker_assignment_periods (organization_id, location_id);
CREATE INDEX idx_worker_assignment_periods_cost_center
  ON worker_assignment_periods (organization_id, cost_center_id);
CREATE INDEX idx_worker_assignment_periods_job_role
  ON worker_assignment_periods (organization_id, job_role_id);
CREATE INDEX idx_worker_assignment_periods_job_level
  ON worker_assignment_periods (organization_id, job_level_id);
CREATE INDEX idx_worker_assignment_periods_schedule
  ON worker_assignment_periods (organization_id, schedule_id);
CREATE INDEX idx_worker_assignment_periods_created_actor
  ON worker_assignment_periods (organization_id, created_by_membership_id);
CREATE INDEX idx_worker_assignment_periods_updated_actor
  ON worker_assignment_periods (organization_id, updated_by_membership_id);

CREATE TABLE worker_reporting_lines (
  reporting_line_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  worker_engagement_id text NOT NULL,
  manager_worker_engagement_id text NOT NULL,
  line_type text NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL DEFAULT 'infinity'::date,
  row_version integer NOT NULL DEFAULT 1,
  created_by_membership_id integer,
  updated_by_membership_id integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT uniq_worker_reporting_lines_org_id UNIQUE (organization_id, reporting_line_id),
  CONSTRAINT fk_worker_reporting_lines_subject FOREIGN KEY (organization_id, worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_engagement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_reporting_lines_manager FOREIGN KEY (organization_id, manager_worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_engagement_id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_reporting_lines_created_actor FOREIGN KEY (organization_id, created_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_reporting_lines_updated_actor FOREIGN KEY (organization_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_worker_reporting_lines_no_self_manager CHECK (worker_engagement_id <> manager_worker_engagement_id),
  CONSTRAINT chk_worker_reporting_lines_dates CHECK (valid_from < valid_to),
  CONSTRAINT chk_worker_reporting_lines_type CHECK (line_type IN ('PRIMARY', 'DOTTED', 'MATRIX', 'FUNCTIONAL')),
  CONSTRAINT chk_worker_reporting_lines_row_version CHECK (row_version > 0),
  CONSTRAINT excl_worker_reporting_lines_overlap EXCLUDE USING gist (
    organization_id WITH =,
    worker_engagement_id WITH =,
    line_type WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);

CREATE INDEX idx_worker_reporting_lines_subject
  ON worker_reporting_lines (organization_id, worker_engagement_id, line_type, valid_from);
CREATE INDEX idx_worker_reporting_lines_manager
  ON worker_reporting_lines (organization_id, manager_worker_engagement_id, valid_from);
CREATE INDEX idx_worker_reporting_lines_created_actor
  ON worker_reporting_lines (organization_id, created_by_membership_id);
CREATE INDEX idx_worker_reporting_lines_updated_actor
  ON worker_reporting_lines (organization_id, updated_by_membership_id);

CREATE TABLE worker_engagement_state_events (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  event_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  worker_engagement_id text NOT NULL,
  event_kind text NOT NULL,
  from_status worker_engagement_status,
  to_status worker_engagement_status NOT NULL,
  effective_date date NOT NULL,
  reason_code text NOT NULL,
  command_scope text NOT NULL,
  command_id text NOT NULL,
  effect_ordinal integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  command_fence_id bigint,
  migration_batch_id text,
  actor_membership_id integer,
  actor_user_id text,
  recorded_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pk_worker_engagement_state_events PRIMARY KEY (organization_id, event_id),
  CONSTRAINT uniq_worker_engagement_state_events_projection UNIQUE (
    organization_id,
    event_id,
    worker_engagement_id,
    to_status
  ),
  CONSTRAINT uniq_worker_engagement_state_events_command UNIQUE (
    organization_id,
    command_scope,
    command_id,
    effect_ordinal
  ),
  CONSTRAINT uniq_worker_engagement_state_events_source UNIQUE (
    organization_id,
    source_type,
    source_id,
    source_ordinal
  ),
  CONSTRAINT fk_worker_engagement_state_events_engagement FOREIGN KEY (organization_id, worker_engagement_id)
    REFERENCES worker_engagements (organization_id, worker_engagement_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_worker_engagement_state_events_ordinals CHECK (effect_ordinal >= 0 AND source_ordinal >= 0),
  CONSTRAINT chk_worker_engagement_state_events_snapshots CHECK (
    (command_fence_id IS NULL OR command_fence_id > 0)
    AND (actor_membership_id IS NULL OR actor_membership_id > 0)
    AND (actor_user_id IS NULL OR btrim(actor_user_id) <> '')
  ),
  CONSTRAINT chk_worker_engagement_state_events_nonblank_keys CHECK (
    btrim(command_scope) <> ''
    AND btrim(command_id) <> ''
    AND btrim(source_type) <> ''
    AND btrim(source_id) <> ''
    AND btrim(reason_code) <> ''
  ),
  CONSTRAINT chk_worker_engagement_state_events_kind CHECK (
    event_kind IN ('LEGACY_SNAPSHOT', 'ENGAGEMENT_CREATED', 'STATUS_CHANGED')
  ),
  CONSTRAINT chk_worker_engagement_state_events_transition CHECK (
    (
      event_kind = 'LEGACY_SNAPSHOT'
      AND from_status IS NULL
    )
    OR (
      event_kind = 'ENGAGEMENT_CREATED'
      AND from_status IS NULL
      AND to_status IN ('PLANNED', 'ACTIVE')
    )
    OR (
      event_kind = 'STATUS_CHANGED'
      AND (
        (from_status = 'PLANNED' AND to_status IN ('ACTIVE', 'CANCELLED'))
        OR (from_status = 'ACTIVE' AND to_status IN ('COMPLETED', 'TERMINATED'))
      )
    )
  ),
  CONSTRAINT chk_worker_engagement_state_events_legacy_batch CHECK (
    (migration_batch_id IS NULL OR btrim(migration_batch_id) <> '')
    AND (event_kind <> 'LEGACY_SNAPSHOT' OR migration_batch_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uniq_worker_engagement_state_events_legacy_snapshot
  ON worker_engagement_state_events (organization_id, worker_engagement_id, event_kind)
  WHERE event_kind = 'LEGACY_SNAPSHOT';
CREATE INDEX idx_worker_engagement_state_events_engagement
  ON worker_engagement_state_events (organization_id, worker_engagement_id, effective_date, event_id);
CREATE INDEX idx_worker_engagement_state_events_fence
  ON worker_engagement_state_events (command_fence_id);
CREATE INDEX idx_worker_engagement_state_events_actor
  ON worker_engagement_state_events (organization_id, actor_membership_id);

ALTER TABLE worker_engagements
  ADD CONSTRAINT fk_worker_engagements_last_state_projection
  FOREIGN KEY (organization_id, last_state_event_id, worker_engagement_id, status)
  REFERENCES worker_engagement_state_events (
    organization_id,
    event_id,
    worker_engagement_id,
    to_status
  )
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;

DO $expand_compatibility$
BEGIN
  IF EXISTS (SELECT 1 FROM worker_engagement_state_events LIMIT 1)
    OR EXISTS (
      SELECT 1
      FROM worker_engagements
      WHERE last_state_event_id IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_BASE_MUST_REMAIN_UNPOPULATED' USING ERRCODE = '55000';
  END IF;
END
$expand_compatibility$;

CREATE OR REPLACE FUNCTION app.verify_workforce_org_unit_kinds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_org text;
  affected_unit text;
BEGIN
  IF TG_TABLE_NAME = 'org_units' THEN
    affected_org := NEW.org_id;
    affected_unit := NEW.id;
    IF EXISTS (
      SELECT 1
      FROM worker_engagements engagement
      WHERE engagement.organization_id = affected_org
        AND (
          (engagement.business_unit_id = affected_unit AND NEW.kind <> 'BUSINESS_UNIT')
          OR (engagement.branch_id = affected_unit AND NEW.kind <> 'BRANCH')
          OR (engagement.department_id = affected_unit AND NEW.kind <> 'DEPARTMENT')
          OR (engagement.team_id = affected_unit AND NEW.kind <> 'TEAM')
          OR (engagement.location_id = affected_unit AND NEW.kind <> 'LOCATION')
        )
    ) OR EXISTS (
      SELECT 1
      FROM worker_assignment_periods assignment
      WHERE assignment.organization_id = affected_org
        AND (
          (assignment.business_unit_id = affected_unit AND NEW.kind <> 'BUSINESS_UNIT')
          OR (assignment.branch_id = affected_unit AND NEW.kind <> 'BRANCH')
          OR (assignment.department_id = affected_unit AND NEW.kind <> 'DEPARTMENT')
          OR (assignment.team_id = affected_unit AND NEW.kind <> 'TEAM')
          OR (assignment.location_id = affected_unit AND NEW.kind <> 'LOCATION')
          OR (assignment.cost_center_id = affected_unit AND NEW.kind <> 'COST_CENTER')
        )
    ) THEN
      RAISE EXCEPTION 'HRMS_ORG_UNIT_KIND_IN_USE' USING ERRCODE = '23514';
    END IF;
  ELSE
    affected_org := NEW.organization_id;
    IF NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.business_unit_id AND kind = 'BUSINESS_UNIT'
    ) THEN
      RAISE EXCEPTION 'HRMS_BUSINESS_UNIT_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.branch_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.branch_id AND kind = 'BRANCH'
    ) THEN
      RAISE EXCEPTION 'HRMS_BRANCH_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.department_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.department_id AND kind = 'DEPARTMENT'
    ) THEN
      RAISE EXCEPTION 'HRMS_DEPARTMENT_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.team_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.team_id AND kind = 'TEAM'
    ) THEN
      RAISE EXCEPTION 'HRMS_TEAM_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    IF NEW.location_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.location_id AND kind = 'LOCATION'
    ) THEN
      RAISE EXCEPTION 'HRMS_LOCATION_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'worker_assignment_periods'
      AND NEW.cost_center_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM org_units WHERE org_id = affected_org AND id = NEW.cost_center_id AND kind = 'COST_CENTER'
      ) THEN
      RAISE EXCEPTION 'HRMS_COST_CENTER_KIND_INVALID' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_workforce_period_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'HRMS_WORKFORCE_PERIOD_REVISION_INVALID' USING ERRCODE = '40001';
  END IF;
  IF TG_TABLE_NAME = 'worker_assignment_periods'
    AND NEW.assignment_period_id <> OLD.assignment_period_id THEN
    RAISE EXCEPTION 'HRMS_ASSIGNMENT_PERIOD_ID_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'worker_reporting_lines'
    AND NEW.reporting_line_id <> OLD.reporting_line_id THEN
    RAISE EXCEPTION 'HRMS_REPORTING_LINE_ID_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.lock_worker_reporting_line_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id, 714218541));
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.lock_worker_engagement_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'streamlineos:hrms:engagement-state:'
      || NEW.organization_id || ':' || NEW.worker_engagement_id,
    0
  ));
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.verify_worker_reporting_line_cycles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  boundary date;
  cycle_found boolean;
BEGIN
  FOR boundary IN
    SELECT candidate.boundary
    FROM (
      SELECT NEW.valid_from AS boundary
      UNION
      SELECT line.valid_from
      FROM worker_reporting_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.valid_from >= NEW.valid_from
        AND line.valid_from < NEW.valid_to
        AND daterange(line.valid_from, line.valid_to, '[)')
          && daterange(NEW.valid_from, NEW.valid_to, '[)')
      UNION
      SELECT line.valid_to
      FROM worker_reporting_lines line
      WHERE line.organization_id = NEW.organization_id
        AND line.valid_to <> 'infinity'::date
        AND line.valid_to >= NEW.valid_from
        AND line.valid_to < NEW.valid_to
        AND daterange(line.valid_from, line.valid_to, '[)')
          && daterange(NEW.valid_from, NEW.valid_to, '[)')
    ) candidate
    ORDER BY candidate.boundary
  LOOP
    WITH RECURSIVE reach(node, path, reaches_subject) AS (
      SELECT
        NEW.manager_worker_engagement_id,
        ARRAY[NEW.manager_worker_engagement_id]::text[],
        NEW.manager_worker_engagement_id = NEW.worker_engagement_id
      UNION ALL
      SELECT
        line.manager_worker_engagement_id,
        reach.path || line.manager_worker_engagement_id,
        line.manager_worker_engagement_id = NEW.worker_engagement_id
      FROM reach
      JOIN worker_reporting_lines line
        ON line.organization_id = NEW.organization_id
        AND line.worker_engagement_id = reach.node
        AND line.valid_from <= boundary
        AND boundary < line.valid_to
      WHERE NOT reach.reaches_subject
        AND (
          line.manager_worker_engagement_id = NEW.worker_engagement_id
          OR NOT line.manager_worker_engagement_id = ANY(reach.path)
        )
    )
    SELECT EXISTS (
      SELECT 1 FROM reach WHERE reaches_subject
    ) INTO cycle_found;
    IF cycle_found THEN
      RAISE EXCEPTION 'HRMS_REPORTING_LINE_CYCLE' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.verify_worker_engagement_state_chain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  prior_event worker_engagement_state_events%ROWTYPE;
  next_event worker_engagement_state_events%ROWTYPE;
  engagement worker_engagements%ROWTYPE;
BEGIN
  SELECT * INTO prior_event
  FROM worker_engagement_state_events
  WHERE organization_id = NEW.organization_id
    AND worker_engagement_id = NEW.worker_engagement_id
    AND event_id < NEW.event_id
  ORDER BY event_id DESC
  LIMIT 1;

  IF prior_event.event_id IS NOT NULL
    AND NEW.effective_date < prior_event.effective_date THEN
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_EFFECTIVE_DATE_REGRESSION' USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'LEGACY_SNAPSHOT' THEN
    IF prior_event.event_id IS NOT NULL THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_INITIAL_EVENT_NOT_FIRST' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM hrms_migration_profiles
      WHERE organization_id = NEW.organization_id
        AND history_mode = 'LEGACY'
    ) THEN
      RAISE EXCEPTION 'HRMS_LEGACY_SNAPSHOT_REQUIRES_LEGACY_HISTORY_MODE' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.event_kind = 'ENGAGEMENT_CREATED' THEN
    IF prior_event.event_id IS NOT NULL OR NEW.to_status NOT IN ('PLANNED', 'ACTIVE') THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_CREATED_EVENT_INVALID' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_kind = 'STATUS_CHANGED' THEN
    IF prior_event.event_id IS NULL
      OR NEW.from_status <> prior_event.to_status
      OR NOT (
        (NEW.from_status = 'PLANNED' AND NEW.to_status IN ('ACTIVE', 'CANCELLED'))
        OR (NEW.from_status = 'ACTIVE' AND NEW.to_status IN ('COMPLETED', 'TERMINATED'))
      ) THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_CHAIN_BROKEN' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_EVENT_KIND_INVALID' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO next_event
  FROM worker_engagement_state_events
  WHERE organization_id = NEW.organization_id
    AND worker_engagement_id = NEW.worker_engagement_id
    AND event_id > NEW.event_id
  ORDER BY event_id
  LIMIT 1;

  IF next_event.event_id IS NOT NULL THEN
    IF next_event.event_kind <> 'STATUS_CHANGED'
      OR next_event.from_status <> NEW.to_status
      OR next_event.effective_date < NEW.effective_date
      OR NOT (
        (NEW.to_status = 'PLANNED' AND next_event.to_status IN ('ACTIVE', 'CANCELLED'))
        OR (NEW.to_status = 'ACTIVE' AND next_event.to_status IN ('COMPLETED', 'TERMINATED'))
      ) THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_CHAIN_BROKEN' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO engagement
    FROM worker_engagements
    WHERE organization_id = NEW.organization_id
      AND worker_engagement_id = NEW.worker_engagement_id;
    IF NOT FOUND
      OR engagement.last_state_event_id <> NEW.event_id
      OR engagement.status <> NEW.to_status THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_PROJECTION_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.verify_worker_engagement_state_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  current_engagement worker_engagements%ROWTYPE;
  latest_event worker_engagement_state_events%ROWTYPE;
  profile_history_mode text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.last_state_event_id IS NOT NULL
    AND NEW.last_state_event_id IS NULL THEN
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_POINTER_CANNOT_BE_CLEARED' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO current_engagement
  FROM worker_engagements
  WHERE organization_id = NEW.organization_id
    AND worker_engagement_id = NEW.worker_engagement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_PROJECTION_MISSING' USING ERRCODE = '23503';
  END IF;

  SELECT history_mode INTO profile_history_mode
  FROM hrms_migration_profiles
  WHERE organization_id = current_engagement.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_HISTORY_PROFILE_MISSING' USING ERRCODE = '55000';
  END IF;

  IF current_engagement.last_state_event_id IS NULL THEN
    IF profile_history_mode <> 'LEGACY' THEN
      RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_PROJECTION_REQUIRED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO latest_event
  FROM worker_engagement_state_events
  WHERE organization_id = current_engagement.organization_id
    AND worker_engagement_id = current_engagement.worker_engagement_id
  ORDER BY event_id DESC
  LIMIT 1;

  IF NOT FOUND
    OR latest_event.event_id <> current_engagement.last_state_event_id
    OR latest_event.to_status <> current_engagement.status THEN
    RAISE EXCEPTION 'HRMS_ENGAGEMENT_STATE_PROJECTION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER verify_worker_engagement_org_unit_kinds
  AFTER INSERT OR UPDATE OF organization_id, business_unit_id, branch_id, department_id, team_id, location_id
  ON worker_engagements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_workforce_org_unit_kinds();
CREATE CONSTRAINT TRIGGER verify_assignment_org_unit_kinds
  AFTER INSERT OR UPDATE OF organization_id, business_unit_id, branch_id, department_id, team_id, location_id, cost_center_id
  ON worker_assignment_periods
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_workforce_org_unit_kinds();
CREATE CONSTRAINT TRIGGER protect_referenced_org_unit_kinds
  AFTER UPDATE OF org_id, id, kind ON org_units
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_workforce_org_unit_kinds();
CREATE TRIGGER enforce_worker_assignment_period_revision
  BEFORE UPDATE ON worker_assignment_periods
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workforce_period_revision();
CREATE TRIGGER enforce_worker_reporting_line_revision
  BEFORE UPDATE ON worker_reporting_lines
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workforce_period_revision();
CREATE TRIGGER lock_worker_reporting_line_tenant
  BEFORE INSERT OR UPDATE ON worker_reporting_lines
  FOR EACH ROW EXECUTE FUNCTION app.lock_worker_reporting_line_tenant();
CREATE TRIGGER lock_worker_engagement_state_event
  BEFORE INSERT ON worker_engagement_state_events
  FOR EACH ROW EXECUTE FUNCTION app.lock_worker_engagement_state_transition();
CREATE TRIGGER lock_worker_engagement_state_projection
  BEFORE UPDATE OF status, last_state_event_id ON worker_engagements
  FOR EACH ROW EXECUTE FUNCTION app.lock_worker_engagement_state_transition();
CREATE CONSTRAINT TRIGGER verify_worker_reporting_line_cycles
  AFTER INSERT OR UPDATE ON worker_reporting_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_worker_reporting_line_cycles();
CREATE CONSTRAINT TRIGGER verify_worker_engagement_state_chain
  AFTER INSERT ON worker_engagement_state_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_worker_engagement_state_chain();
CREATE CONSTRAINT TRIGGER verify_worker_engagement_state_projection
  AFTER INSERT OR UPDATE OF status, last_state_event_id ON worker_engagements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_worker_engagement_state_projection();
CREATE TRIGGER reject_worker_engagement_state_event_mutation
  BEFORE UPDATE OR DELETE ON worker_engagement_state_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_engagement_state_event_truncate
  BEFORE TRUNCATE ON worker_engagement_state_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_assignment_period_delete
  BEFORE DELETE ON worker_assignment_periods
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_assignment_period_truncate
  BEFORE TRUNCATE ON worker_assignment_periods
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_reporting_line_delete
  BEFORE DELETE ON worker_reporting_lines
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_reporting_line_truncate
  BEFORE TRUNCATE ON worker_reporting_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();

ALTER TABLE worker_assignment_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_engagement_state_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON worker_assignment_periods
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON worker_reporting_lines
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON worker_engagement_state_events
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());

REVOKE ALL ON worker_assignment_periods FROM PUBLIC;
REVOKE ALL ON worker_reporting_lines FROM PUBLIC;
REVOKE ALL ON worker_engagement_state_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE worker_engagement_state_events_event_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION app.verify_workforce_org_unit_kinds() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.verify_worker_reporting_line_cycles() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.verify_worker_engagement_state_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.verify_worker_engagement_state_projection() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_worker_engagement_state_transition() FROM PUBLIC;

DO $grants$
DECLARE
  application_role text := coalesce(nullif(current_setting('app.bootstrap_role', true), ''), 'streamline_app');
  execution_role text := coalesce(nullif(current_setting('app.hrms_migration_role', true), ''), 'streamline_hrms_migration');
BEGIN
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE worker_assignment_periods, worker_reporting_lines, worker_engagement_state_events FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE worker_engagement_state_events_event_id_seq FROM %I',
    application_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', application_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id() TO %I', application_role);

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE worker_assignment_periods, worker_reporting_lines, worker_engagement_state_events FROM %I',
    execution_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON SEQUENCE worker_engagement_state_events_event_id_seq FROM %I',
    execution_role
  );
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', execution_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.current_org_id() TO %I', execution_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON worker_assignment_periods, worker_reporting_lines TO %I', execution_role);
  EXECUTE format('GRANT SELECT, INSERT ON worker_engagement_state_events TO %I', execution_role);
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE worker_engagement_state_events_event_id_seq TO %I', execution_role);
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
      ('worker_assignment_periods'::regclass, ARRAY['SELECT', 'INSERT', 'UPDATE']::text[]),
      ('worker_reporting_lines'::regclass, ARRAY['SELECT', 'INSERT', 'UPDATE']::text[]),
      ('worker_engagement_state_events'::regclass, ARRAY['SELECT', 'INSERT']::text[]),
      ('app.hrms_sql_bundle_operations'::regclass, ARRAY['SELECT', 'INSERT', 'UPDATE']::text[])
    ) expected(relation_oid, execution_table_privileges)
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
      IF has_table_privilege(
        application_role,
        target.relation_oid,
        privilege_name
      ) THEN
        RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_TABLE_PRIVILEGE: % %', target.relation_oid, privilege_name
          USING ERRCODE = '42501';
      END IF;
      execution_expected := privilege_name = ANY(target.execution_table_privileges);
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
        IF has_column_privilege(
          application_role,
          target.relation_oid,
          attribute.attnum,
          privilege_name
        ) THEN
          RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_COLUMN_PRIVILEGE: % % %', target.relation_oid, attribute.attname, privilege_name
            USING ERRCODE = '42501';
        END IF;
        execution_expected := privilege_name = ANY(target.execution_table_privileges);
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
      'worker_engagement_state_events_event_id_seq',
      privilege_name
    ) THEN
      RAISE EXCEPTION 'HRMS_APPLICATION_ROLE_STATE_EVENT_SEQUENCE_PRIVILEGE: %', privilege_name
        USING ERRCODE = '42501';
    END IF;
    execution_expected := privilege_name IN ('USAGE', 'SELECT');
    IF has_sequence_privilege(
      execution_role,
      'worker_engagement_state_events_event_id_seq',
      privilege_name
    ) IS DISTINCT FROM execution_expected THEN
      RAISE EXCEPTION 'HRMS_EXECUTION_ROLE_STATE_EVENT_SEQUENCE_PRIVILEGE_MISMATCH: %', privilege_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_class sequence
    CROSS JOIN LATERAL aclexplode(
      coalesce(sequence.relacl, '{}'::aclitem[])
    ) access
    WHERE sequence.oid = 'worker_engagement_state_events_event_id_seq'::regclass
      AND access.grantee = 0
  ) THEN
    RAISE EXCEPTION 'HRMS_PUBLIC_STATE_EVENT_SEQUENCE_PRIVILEGE'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'worker_assignment_periods',
      'worker_reporting_lines',
      'worker_engagement_state_events'
    ]::text[]) target(table_name)
    JOIN pg_class relation ON relation.oid = target.table_name::regclass
    WHERE NOT relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'HRMS_EFFECTIVE_HISTORY_RLS_NOT_ENABLED' USING ERRCODE = '42501';
  END IF;
END
$grant_assertions$;

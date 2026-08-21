SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

DO $preflight$
DECLARE
  bundle_operation_id text := nullif(btrim(current_setting('app.hrms_bundle_operation_id', true)), '');
  requested_bundle_id text := nullif(btrim(current_setting('app.hrms_bundle_id', true)), '');
  bundle_file_name text := nullif(btrim(current_setting('app.hrms_bundle_file_name', true)), '');
  bundle_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_sql_hash', true)), '');
  bundle_dependency_sql_hash text := nullif(btrim(current_setting('app.hrms_bundle_dependency_sql_hash', true)), '');
  bundle_manifest_hash text := nullif(btrim(current_setting('app.hrms_bundle_manifest_hash', true)), '');
  bundle_root_migration_hash text := nullif(btrim(current_setting('app.hrms_bundle_root_migration_hash', true)), '');
BEGIN
  IF bundle_operation_id IS NULL
    OR requested_bundle_id IS NULL
    OR bundle_file_name IS NULL
    OR bundle_sql_hash IS NULL
    OR bundle_dependency_sql_hash IS NULL
    OR bundle_manifest_hash IS NULL
    OR bundle_root_migration_hash IS NULL THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_METADATA_MISSING' USING ERRCODE = '22023';
  END IF;
  IF bundle_file_name <> '0004_hrms_hierarchy_audit.sql' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF bundle_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_dependency_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_manifest_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_root_migration_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('app.hrms_sql_bundle_operations') IS NULL THEN
    RAISE EXCEPTION 'HRMS_HIERARCHY_AUDIT_REQUIRES_0003' USING ERRCODE = '42P01';
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
    RAISE EXCEPTION 'HRMS_HIERARCHY_AUDIT_CURRENT_OPERATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations prior_operation
    WHERE prior_operation.bundle_id = requested_bundle_id
      AND prior_operation.file_name = '0003_hrms_attendance_events.sql'
      AND prior_operation.sql_hash = bundle_dependency_sql_hash
      AND prior_operation.root_migration_hash = bundle_root_migration_hash
      AND prior_operation.state = 'COMPLETE'
      AND prior_operation.database_name = current_database()
      AND prior_operation.database_role = current_user
      AND prior_operation.server_version_num = current_setting('server_version_num')::integer
  ) THEN
    RAISE EXCEPTION 'HRMS_HIERARCHY_AUDIT_REQUIRES_COMPLETE_0003_OPERATION' USING ERRCODE = '55000';
  END IF;
END
$preflight$;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regprocedure('app.reject_hrms_append_only_mutation()') IS NULL THEN
    RAISE EXCEPTION 'HRMS_MIGRATION_DEPENDENCY_MISSING: shared append-only guard'
      USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE app.hrms_partition_operations (
  operation_id text NOT NULL,
  approval_id text NOT NULL,
  manifest_hash text NOT NULL,
  base_bundle_id text NOT NULL,
  root_migration_name text NOT NULL,
  root_migration_hash text NOT NULL,
  base_dependencies_hash text NOT NULL,
  database_name text NOT NULL,
  database_role text NOT NULL,
  server_version_num integer NOT NULL,
  parent_table text NOT NULL,
  child_table text NOT NULL,
  partition_kind text NOT NULL,
  range_from date,
  range_to date,
  hash_modulus integer,
  hash_remainder integer,
  security_profile text NOT NULL,
  ddl_hash text NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  last_error text,
  CONSTRAINT pk_hrms_partition_operations PRIMARY KEY (operation_id),
  CONSTRAINT uniq_hrms_partition_operations_manifest_child
    UNIQUE (manifest_hash, parent_table, child_table),
  CONSTRAINT chk_hrms_partition_operations_identity CHECK (
    char_length(operation_id) BETWEEN 3 AND 512
    AND operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$'
    AND char_length(approval_id) BETWEEN 3 AND 128
    AND approval_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
    AND char_length(base_bundle_id) BETWEEN 3 AND 128
    AND base_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$'
    AND root_migration_name = '0398_backfill_hr_admin_branch_hr_recruitment_grants.sql'
    AND char_length(database_name) BETWEEN 1 AND 128
    AND database_name ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
    AND database_role ~ '^[A-Za-z_][A-Za-z0-9_$-]{0,62}$'
    AND parent_table ~ '^[a-z][a-z0-9_]{0,62}$'
    AND child_table ~ '^[a-z][a-z0-9_]{0,62}$'
    AND server_version_num > 0
  ),
  CONSTRAINT chk_hrms_partition_operations_hashes CHECK (
    manifest_hash ~ '^[0-9a-f]{64}$'
    AND root_migration_hash ~ '^[0-9a-f]{64}$'
    AND base_dependencies_hash ~ '^[0-9a-f]{64}$'
    AND ddl_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT chk_hrms_partition_operations_partition CHECK (
    (
      partition_kind = 'RANGE'
      AND parent_table IN (
        'attendance_events',
        'attendance_event_evidence',
        'worker_leave_ledger_entries',
        'hr_audit_events'
      )
      AND range_from IS NOT NULL
      AND range_to IS NOT NULL
      AND range_from >= DATE '0001-01-01'
      AND range_from <= DATE '9999-12-01'
      AND extract(day FROM range_from) = 1
      AND range_to = (range_from + interval '1 month')::date
      AND hash_modulus IS NULL
      AND hash_remainder IS NULL
      AND child_table = parent_table
        || '_y'
        || lpad(extract(year FROM range_from)::integer::text, 4, '0')
        || 'm'
        || lpad(extract(month FROM range_from)::integer::text, 2, '0')
    )
    OR (
      partition_kind = 'HASH'
      AND parent_table IN (
        'attendance_event_locators',
        'attendance_correction_links',
        'hr_audit_event_sources',
        'worker_leave_entry_locators',
        'worker_leave_reversal_links'
      )
      AND range_from IS NULL
      AND range_to IS NULL
      AND hash_modulus = 16
      AND hash_remainder BETWEEN 0 AND 15
      AND child_table = parent_table
        || '_h'
        || lpad(hash_remainder::text, 2, '0')
    )
  ),
  CONSTRAINT chk_hrms_partition_operations_security_profile CHECK (
    security_profile = 'base-owner-only-v1'
  ),
  CONSTRAINT chk_hrms_partition_operations_state CHECK (
    state IN ('RUNNING', 'VERIFYING', 'COMPLETE', 'FAILED')
  ),
  CONSTRAINT chk_hrms_partition_operations_attempts CHECK (attempts > 0),
  CONSTRAINT chk_hrms_partition_operations_error CHECK (
    last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_.:-]{0,255}$'
  ),
  CONSTRAINT chk_hrms_partition_operations_timestamps CHECK (
    completed_at IS NULL OR completed_at >= started_at
  ),
  CONSTRAINT chk_hrms_partition_operations_state_shape CHECK (
    (
      state IN ('RUNNING', 'VERIFYING')
      AND completed_at IS NULL
      AND last_error IS NULL
    )
    OR (
      state = 'COMPLETE'
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.enforce_hrms_partition_operation_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('RUNNING', 'FAILED') THEN
      RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_INITIAL_STATE_INVALID'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.operation_id,
    NEW.approval_id,
    NEW.manifest_hash,
    NEW.base_bundle_id,
    NEW.root_migration_name,
    NEW.root_migration_hash,
    NEW.base_dependencies_hash,
    NEW.database_name,
    NEW.database_role,
    NEW.server_version_num,
    NEW.parent_table,
    NEW.child_table,
    NEW.partition_kind,
    NEW.range_from,
    NEW.range_to,
    NEW.hash_modulus,
    NEW.hash_remainder,
    NEW.security_profile,
    NEW.ddl_hash
  ) IS DISTINCT FROM ROW(
    OLD.operation_id,
    OLD.approval_id,
    OLD.manifest_hash,
    OLD.base_bundle_id,
    OLD.root_migration_name,
    OLD.root_migration_hash,
    OLD.base_dependencies_hash,
    OLD.database_name,
    OLD.database_role,
    OLD.server_version_num,
    OLD.parent_table,
    OLD.child_table,
    OLD.partition_kind,
    OLD.range_from,
    OLD.range_to,
    OLD.hash_modulus,
    OLD.hash_remainder,
    OLD.security_profile,
    OLD.ddl_hash
  ) THEN
    RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_IDENTITY_IMMUTABLE'
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
  ) THEN
    RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_TRANSITION_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.enforce_hrms_partition_operation_transition() FROM PUBLIC;

CREATE TRIGGER enforce_hrms_partition_operation_transition
  BEFORE INSERT OR UPDATE ON app.hrms_partition_operations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_hrms_partition_operation_transition();
CREATE TRIGGER reject_hrms_partition_operation_delete
  BEFORE DELETE ON app.hrms_partition_operations
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hrms_partition_operation_truncate
  BEFORE TRUNCATE ON app.hrms_partition_operations
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
--> statement-breakpoint

REVOKE ALL ON app.hrms_partition_operations FROM PUBLIC;

DO $partition_operation_security$
DECLARE
  application_role text := coalesce(nullif(current_setting('app.bootstrap_role', true), ''), 'streamline_app');
  migration_role text := coalesce(nullif(current_setting('app.hrms_migration_role', true), ''), 'streamline_hrms_migration');
  target_oid oid := 'app.hrms_partition_operations'::regclass;
  target_owner oid;
  attribute record;
  privilege_name text;
  role_name text;
  has_maintain boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role)
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migration_role) THEN
    RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_ROLE_MISSING'
      USING ERRCODE = '42704';
  END IF;

  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE app.hrms_partition_operations FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE app.hrms_partition_operations FROM %I',
    migration_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION app.enforce_hrms_partition_operation_transition() FROM %I',
    application_role
  );
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON FUNCTION app.enforce_hrms_partition_operation_transition() FROM %I',
    migration_role
  );

  FOREACH role_name IN ARRAY ARRAY[application_role, migration_role]::text[]
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
      IF has_table_privilege(role_name, target_oid, privilege_name) THEN
        RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_ROLE_PRIVILEGE: % %', role_name, privilege_name
          USING ERRCODE = '42501';
      END IF;
    END LOOP;

    FOR attribute IN
      SELECT attnum, attname
      FROM pg_attribute
      WHERE attrelid = target_oid
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
          role_name,
          target_oid,
          attribute.attnum,
          privilege_name
        ) THEN
          RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_ROLE_COLUMN_PRIVILEGE: % % %', role_name, attribute.attname, privilege_name
            USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END LOOP;

    has_maintain := false;
    IF current_setting('server_version_num')::integer >= 170000 THEN
      EXECUTE 'SELECT has_table_privilege($1::name, $2::oid, ''MAINTAIN'')'
        INTO has_maintain
        USING role_name, target_oid;
    END IF;
    IF has_maintain THEN
      RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_ROLE_MAINTAIN: %', role_name
        USING ERRCODE = '42501';
    END IF;
    IF has_function_privilege(
      role_name,
      'app.enforce_hrms_partition_operation_transition()',
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_ROLE_FUNCTION_EXECUTE: %', role_name
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  SELECT relowner INTO target_owner
  FROM pg_class
  WHERE oid = target_oid;
  IF pg_get_userbyid(target_owner) <> current_user
    OR EXISTS (
      SELECT 1
      FROM aclexplode(coalesce(
        (SELECT relacl FROM pg_class WHERE oid = target_oid),
        acldefault('r', target_owner)
      )) access
      WHERE access.grantee <> target_owner
    )
    OR EXISTS (
      SELECT 1
      FROM pg_attribute target_attribute
      CROSS JOIN LATERAL aclexplode(
        coalesce(target_attribute.attacl, '{}'::aclitem[])
      ) access
      WHERE target_attribute.attrelid = target_oid
        AND target_attribute.attnum > 0
        AND NOT target_attribute.attisdropped
    ) THEN
    RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_OWNER_ONLY_ACL_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(
      routine.proacl,
      acldefault('f', routine.proowner)
    )) access
    WHERE routine.oid = 'app.enforce_hrms_partition_operation_transition()'::regprocedure
      AND access.grantee <> routine.proowner
  ) THEN
    RAISE EXCEPTION 'HRMS_PARTITION_OPERATION_FUNCTION_ACL_MISMATCH'
      USING ERRCODE = '42501';
  END IF;
END
$partition_operation_security$;
--> statement-breakpoint

ALTER TABLE org_units
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer;
--> statement-breakpoint

ALTER TABLE org_units
  ADD CONSTRAINT chk_org_units_row_version_positive
    CHECK (row_version > 0) NOT VALID,
  ADD CONSTRAINT chk_org_units_kind
    CHECK (kind IN (
      'BUSINESS_UNIT', 'BRANCH', 'DEPARTMENT',
      'TEAM', 'LOCATION', 'COST_CENTER'
    )) NOT VALID,
  ADD CONSTRAINT chk_org_units_status
    CHECK (status IN ('ACTIVE', 'DISABLED', 'ARCHIVED')) NOT VALID,
  ADD CONSTRAINT chk_org_units_parent_not_self
    CHECK (parent_id IS NULL OR parent_id <> id) NOT VALID,
  ADD CONSTRAINT fk_org_units_parent_tenant
    FOREIGN KEY (org_id, parent_id)
    REFERENCES org_units (org_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_org_units_archived_by_membership
    FOREIGN KEY (org_id, archived_by_membership_id)
    REFERENCES organization_members (org_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_org_units_updated_by_membership
    FOREIGN KEY (org_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id)
    ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_org_unit_parent_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'streamlineos:hrms:org-unit-hierarchy:' || NEW.org_id,
    0
  ));
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT
        parent.id,
        parent.parent_id,
        ARRAY[parent.id]::text[] AS path,
        false AS cycle
      FROM org_units parent
      WHERE parent.org_id = NEW.org_id
        AND parent.id = NEW.parent_id
      UNION ALL
      SELECT
        parent.id,
        parent.parent_id,
        ancestors.path || parent.id,
        parent.id = ANY(ancestors.path)
      FROM org_units parent
      JOIN ancestors
        ON parent.org_id = NEW.org_id
       AND parent.id = ancestors.parent_id
      WHERE NOT ancestors.cycle
    )
    SELECT 1
    FROM ancestors
    WHERE id = NEW.id OR cycle
  ) THEN
    RAISE EXCEPTION 'HRMS_ORG_UNIT_CYCLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.verify_org_unit_parent_cycle() FROM PUBLIC;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER verify_org_unit_parent_cycle
  AFTER INSERT OR UPDATE OF parent_id ON org_units
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_org_unit_parent_cycle();
--> statement-breakpoint

CREATE TABLE org_unit_closure (
  organization_id text NOT NULL,
  ancestor_id text NOT NULL,
  descendant_id text NOT NULL,
  depth integer NOT NULL,
  CONSTRAINT pk_org_unit_closure
    PRIMARY KEY (organization_id, ancestor_id, descendant_id),
  CONSTRAINT fk_org_unit_closure_ancestor_tenant
    FOREIGN KEY (organization_id, ancestor_id)
    REFERENCES org_units (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_org_unit_closure_descendant_tenant
    FOREIGN KEY (organization_id, descendant_id)
    REFERENCES org_units (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_org_unit_closure_depth
    CHECK (
      (ancestor_id = descendant_id AND depth = 0)
      OR (ancestor_id <> descendant_id AND depth > 0)
    )
);
--> statement-breakpoint

CREATE INDEX idx_org_unit_closure_descendant_scope
  ON org_unit_closure (
    organization_id,
    descendant_id,
    depth,
    ancestor_id
  );
--> statement-breakpoint

CREATE TABLE hr_audit_event_sources (
  organization_id text NOT NULL,
  audit_event_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  occurred_at timestamptz NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_audit_event_sources
    PRIMARY KEY (organization_id, audit_event_id),
  CONSTRAINT uniq_hr_audit_event_sources_event_time
    UNIQUE (organization_id, audit_event_id, occurred_at),
  CONSTRAINT uniq_hr_audit_event_sources_source
    UNIQUE (organization_id, source_type, source_id, source_ordinal),
  CONSTRAINT fk_hr_audit_event_sources_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_hr_audit_event_sources_key
    CHECK (
      btrim(source_type) <> '' AND btrim(source_id) <> ''
      AND source_ordinal >= 0
    )
) PARTITION BY HASH (organization_id);
--> statement-breakpoint

DO $$
DECLARE
  remainder integer;
  child_name text;
BEGIN
  FOR remainder IN 0..15 LOOP
    child_name := 'hr_audit_event_sources_h'
      || lpad(remainder::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF hr_audit_event_sources FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      child_name,
      remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX idx_hr_audit_event_sources_org_time
  ON hr_audit_event_sources (organization_id, occurred_at);
--> statement-breakpoint

CREATE TABLE hr_audit_events (
  organization_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  audit_event_id bigint NOT NULL,
  actor_user_id text,
  actor_membership_id integer,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  request_id text,
  correlation_id text,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  migration_batch_id text,
  redacted_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pk_hr_audit_events
    PRIMARY KEY (organization_id, occurred_at, audit_event_id),
  CONSTRAINT uniq_hr_audit_events_source
    UNIQUE (
      organization_id,
      occurred_at,
      source_type,
      source_id,
      source_ordinal
    ),
  CONSTRAINT fk_hr_audit_events_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_hr_audit_events_source
    FOREIGN KEY (organization_id, audit_event_id, occurred_at)
    REFERENCES hr_audit_event_sources (
      organization_id,
      audit_event_id,
      occurred_at
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_hr_audit_events_source_ordinal_nonnegative
    CHECK (source_ordinal >= 0),
  CONSTRAINT chk_hr_audit_events_required_text
    CHECK (
      btrim(entity_type) <> '' AND btrim(entity_id) <> ''
      AND btrim(action) <> '' AND btrim(source_type) <> ''
      AND btrim(source_id) <> ''
    ),
  CONSTRAINT chk_hr_audit_events_optional_text
    CHECK (
      (request_id IS NULL OR btrim(request_id) <> '')
      AND (correlation_id IS NULL OR btrim(correlation_id) <> '')
      AND (migration_batch_id IS NULL OR btrim(migration_batch_id) <> '')
    ),
  CONSTRAINT chk_hr_audit_events_redacted_diff_object
    CHECK (jsonb_typeof(redacted_diff) = 'object')
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint

ALTER TABLE hr_audit_event_sources
  ADD CONSTRAINT fk_hr_audit_event_sources_fact
  FOREIGN KEY (organization_id, occurred_at, audit_event_id)
  REFERENCES hr_audit_events (organization_id, occurred_at, audit_event_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE INDEX idx_hr_audit_events_org_entity_time
  ON hr_audit_events (
    organization_id,
    entity_type,
    entity_id,
    occurred_at
  );
CREATE INDEX idx_hr_audit_events_org_actor_time
  ON hr_audit_events (
    organization_id,
    actor_membership_id,
    occurred_at
  );
CREATE INDEX idx_hr_audit_events_org_correlation
  ON hr_audit_events (organization_id, correlation_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_hr_audit_source_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source hr_audit_event_sources%ROWTYPE;
  fact hr_audit_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME LIKE 'hr_audit_event_sources%' THEN
    SELECT * INTO fact
    FROM hr_audit_events
    WHERE organization_id = NEW.organization_id
      AND occurred_at = NEW.occurred_at
      AND audit_event_id = NEW.audit_event_id;
    IF fact.audit_event_id IS NULL
      OR fact.source_type <> NEW.source_type
      OR fact.source_id <> NEW.source_id
      OR fact.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_AUDIT_SOURCE_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO source
    FROM hr_audit_event_sources
    WHERE organization_id = NEW.organization_id
      AND audit_event_id = NEW.audit_event_id;
    IF source.audit_event_id IS NULL
      OR source.occurred_at <> NEW.occurred_at
      OR source.source_type <> NEW.source_type
      OR source.source_id <> NEW.source_id
      OR source.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_AUDIT_SOURCE_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'hr_audit_event_sources'::regclass,
      'hr_audit_events'::regclass
    )
  LOOP
    EXECUTE format(
      'CREATE CONSTRAINT TRIGGER verify_hr_audit_source_fact AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_hr_audit_source_fact()',
      target
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE TRIGGER reject_hr_audit_event_source_mutation
  BEFORE UPDATE OR DELETE ON hr_audit_event_sources
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_hr_audit_event_mutation
  BEFORE UPDATE OR DELETE ON hr_audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT 'hr_audit_event_sources'::regclass
    UNION ALL SELECT 'hr_audit_events'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'hr_audit_event_sources'::regclass,
      'hr_audit_events'::regclass
    )
  LOOP
    EXECUTE format(
      'CREATE TRIGGER reject_hrms_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION app.reject_hrms_append_only_mutation()',
      target
    );
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
  app_role text := coalesce(
    nullif(current_setting('app.bootstrap_role', true), ''),
    'streamline_app'
  );
  has_maintain boolean;
  public_column_access boolean;
BEGIN
  ALTER TABLE org_unit_closure ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON org_unit_closure
    USING (organization_id = app.current_org_id())
    WITH CHECK (organization_id = app.current_org_id());
  REVOKE ALL PRIVILEGES ON org_unit_closure FROM PUBLIC;
  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
    WHERE attribute.attrelid = 'org_unit_closure'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = 0
  ) INTO public_column_access;
  IF public_column_access THEN
    RAISE EXCEPTION 'HRMS_HIERARCHY_PUBLIC_COLUMN_PRIVILEGE'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON org_unit_closure FROM %I',
      app_role
    );
  END IF;

  FOR target IN
    SELECT 'hr_audit_event_sources'::regclass
    UNION ALL SELECT 'hr_audit_events'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'hr_audit_event_sources'::regclass,
      'hr_audit_events'::regclass
    )
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (organization_id = app.current_org_id()) WITH CHECK (organization_id = app.current_org_id())',
      target
    );
    EXECUTE format('REVOKE ALL PRIVILEGES ON %s FROM PUBLIC', target);
    SELECT EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
      WHERE attribute.attrelid = target
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = 0
    ) INTO public_column_access;
    IF public_column_access THEN
      RAISE EXCEPTION 'HRMS_AUDIT_PUBLIC_COLUMN_PRIVILEGE: %', target
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON %s FROM %I',
        target,
        app_role
      );
      has_maintain := false;
      IF current_setting('server_version_num')::integer >= 170000 THEN
        SELECT has_table_privilege(app_role, target, 'MAINTAIN')
        INTO has_maintain;
      END IF;
      IF has_table_privilege(app_role, target, 'SELECT')
        OR has_table_privilege(app_role, target, 'INSERT')
        OR has_table_privilege(app_role, target, 'UPDATE')
        OR has_table_privilege(app_role, target, 'DELETE')
        OR has_table_privilege(app_role, target, 'TRUNCATE')
        OR has_table_privilege(app_role, target, 'REFERENCES')
        OR has_table_privilege(app_role, target, 'TRIGGER')
        OR has_any_column_privilege(app_role, target, 'SELECT')
        OR has_any_column_privilege(app_role, target, 'INSERT')
        OR has_any_column_privilege(app_role, target, 'UPDATE')
        OR has_any_column_privilege(app_role, target, 'REFERENCES')
        OR has_maintain THEN
        RAISE EXCEPTION 'HRMS_AUDIT_ROLE_PRIVILEGE_NOT_REVOKED: %', target
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    has_maintain := false;
    IF current_setting('server_version_num')::integer >= 170000 THEN
      SELECT has_table_privilege(app_role, 'org_unit_closure', 'MAINTAIN')
      INTO has_maintain;
    END IF;
    IF has_table_privilege(app_role, 'org_unit_closure', 'SELECT')
      OR has_table_privilege(app_role, 'org_unit_closure', 'INSERT')
      OR has_table_privilege(app_role, 'org_unit_closure', 'UPDATE')
      OR has_table_privilege(app_role, 'org_unit_closure', 'DELETE')
      OR has_table_privilege(app_role, 'org_unit_closure', 'TRUNCATE')
      OR has_table_privilege(app_role, 'org_unit_closure', 'REFERENCES')
      OR has_table_privilege(app_role, 'org_unit_closure', 'TRIGGER')
      OR has_any_column_privilege(app_role, 'org_unit_closure', 'SELECT')
      OR has_any_column_privilege(app_role, 'org_unit_closure', 'INSERT')
      OR has_any_column_privilege(app_role, 'org_unit_closure', 'UPDATE')
      OR has_any_column_privilege(app_role, 'org_unit_closure', 'REFERENCES')
      OR has_maintain THEN
      RAISE EXCEPTION 'HRMS_HIERARCHY_ROLE_PRIVILEGE_NOT_REVOKED'
        USING ERRCODE = '42501';
    END IF;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE hr_audit_event_sources_audit_event_id_seq FROM %I',
      app_role
    );
    IF has_sequence_privilege(
      app_role,
      'hr_audit_event_sources_audit_event_id_seq',
      'USAGE'
    ) OR has_sequence_privilege(
      app_role,
      'hr_audit_event_sources_audit_event_id_seq',
      'SELECT'
    ) OR has_sequence_privilege(
      app_role,
      'hr_audit_event_sources_audit_event_id_seq',
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'HRMS_AUDIT_SEQUENCE_PRIVILEGE_NOT_REVOKED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  REVOKE ALL PRIVILEGES
    ON SEQUENCE hr_audit_event_sources_audit_event_id_seq
    FROM PUBLIC;
END $$;

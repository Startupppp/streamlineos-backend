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
  IF bundle_file_name <> '0002_hrms_leave_ledger.sql' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF bundle_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_dependency_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_manifest_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_root_migration_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('app.hrms_sql_bundle_operations') IS NULL THEN
    RAISE EXCEPTION 'HRMS_LEAVE_LEDGER_REQUIRES_0001' USING ERRCODE = '42P01';
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
    RAISE EXCEPTION 'HRMS_LEAVE_LEDGER_CURRENT_OPERATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations prior_operation
    WHERE prior_operation.bundle_id = requested_bundle_id
      AND prior_operation.file_name = '0001_hrms_effective_history.sql'
      AND prior_operation.sql_hash = bundle_dependency_sql_hash
      AND prior_operation.root_migration_hash = bundle_root_migration_hash
      AND prior_operation.state = 'COMPLETE'
      AND prior_operation.database_name = current_database()
      AND prior_operation.database_role = current_user
      AND prior_operation.server_version_num = current_setting('server_version_num')::integer
  ) THEN
    RAISE EXCEPTION 'HRMS_LEAVE_LEDGER_REQUIRES_COMPLETE_0001_OPERATION' USING ERRCODE = '55000';
  END IF;
END
$preflight$;
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_engagement_id text,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_by_membership_id integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE leave_requests
  ADD CONSTRAINT chk_leave_requests_row_version
    CHECK (row_version > 0) NOT VALID,
  ADD CONSTRAINT chk_leave_requests_canonical_subject_pair
    CHECK ((worker_id IS NULL) = (worker_engagement_id IS NULL)) NOT VALID,
  ADD CONSTRAINT fk_leave_requests_org_worker
    FOREIGN KEY (org_id, worker_id)
    REFERENCES workers (organization_id, worker_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_leave_requests_worker_engagement
    FOREIGN KEY (org_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_leave_requests_created_actor
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members (org_id, id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_leave_requests_updated_actor
    FOREIGN KEY (org_id, updated_by_membership_id)
    REFERENCES organization_members (org_id, id)
    ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leave_requests_org_worker
  ON leave_requests (org_id, worker_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_engagement
  ON leave_requests (org_id, worker_engagement_id);
--> statement-breakpoint

CREATE TABLE worker_leave_entry_locators (
  organization_id text NOT NULL,
  entry_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  effective_date date NOT NULL,
  command_scope text NOT NULL,
  command_id text NOT NULL,
  effect_ordinal integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  CONSTRAINT pk_worker_leave_entry_locators
    PRIMARY KEY (organization_id, entry_id),
  CONSTRAINT uniq_worker_leave_locators_entry_date
    UNIQUE (organization_id, entry_id, effective_date),
  CONSTRAINT uniq_worker_leave_locators_command
    UNIQUE (organization_id, command_scope, command_id, effect_ordinal),
  CONSTRAINT uniq_worker_leave_locators_source
    UNIQUE (organization_id, source_type, source_id, source_ordinal),
  CONSTRAINT fk_worker_leave_locators_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_worker_leave_locators_command_key
    CHECK (
      btrim(command_scope) <> '' AND btrim(command_id) <> ''
      AND effect_ordinal >= 0
    ),
  CONSTRAINT chk_worker_leave_locators_source_key
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
    child_name := 'worker_leave_entry_locators_h' || lpad(remainder::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF worker_leave_entry_locators FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      child_name,
      remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX idx_worker_leave_locators_org_date
  ON worker_leave_entry_locators (organization_id, effective_date);
--> statement-breakpoint

CREATE TABLE worker_leave_ledger_entries (
  organization_id text NOT NULL,
  effective_date date NOT NULL,
  entry_id bigint NOT NULL,
  worker_id text NOT NULL,
  worker_engagement_id text NOT NULL,
  leave_type_id integer NOT NULL,
  period_key text NOT NULL,
  delta_days numeric(12, 4) NOT NULL,
  entry_type text NOT NULL,
  provenance_status text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  command_scope text NOT NULL,
  command_id text NOT NULL,
  effect_ordinal integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  actor_membership_id integer,
  actor_user_id text,
  migration_batch_id text,
  CONSTRAINT pk_worker_leave_ledger_entries
    PRIMARY KEY (organization_id, effective_date, entry_id),
  CONSTRAINT fk_worker_leave_entries_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_entries_locator
    FOREIGN KEY (organization_id, entry_id, effective_date)
    REFERENCES worker_leave_entry_locators (
      organization_id,
      entry_id,
      effective_date
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_worker_leave_entries_org_worker
    FOREIGN KEY (organization_id, worker_id)
    REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_entries_worker_engagement
    FOREIGN KEY (organization_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_entries_org_leave_type
    FOREIGN KEY (organization_id, leave_type_id)
    REFERENCES leave_types (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_worker_leave_entries_entry_type
    CHECK (entry_type IN (
      'ACCRUAL', 'CONSUMPTION', 'CARRY_FORWARD', 'ENCASHMENT',
      'EXPIRY', 'ADJUSTMENT', 'COMP_OFF_EARN', 'COMP_OFF_USE',
      'REVERSAL', 'LEGACY_OPENING_BALANCE'
    )),
  CONSTRAINT chk_worker_leave_entries_provenance
    CHECK (provenance_status IN ('VERIFIED_SOURCE', 'UNVERIFIED_LEGACY')),
  CONSTRAINT chk_worker_leave_entries_legacy_pair
    CHECK (
      (provenance_status = 'UNVERIFIED_LEGACY') =
      (entry_type = 'LEGACY_OPENING_BALANCE')
    ),
  CONSTRAINT chk_worker_leave_entries_migration_batch
    CHECK (migration_batch_id IS NULL OR btrim(migration_batch_id) <> ''),
  CONSTRAINT chk_worker_leave_entries_legacy_batch
    CHECK (
      provenance_status <> 'UNVERIFIED_LEGACY'
      OR migration_batch_id IS NOT NULL
    ),
  CONSTRAINT chk_worker_leave_entries_command_key
    CHECK (
      btrim(command_scope) <> '' AND btrim(command_id) <> ''
      AND effect_ordinal >= 0
    ),
  CONSTRAINT chk_worker_leave_entries_source_key
    CHECK (
      btrim(source_type) <> '' AND btrim(source_id) <> ''
      AND source_ordinal >= 0
    ),
  CONSTRAINT chk_worker_leave_entries_period_key
    CHECK (btrim(period_key) <> ''),
  CONSTRAINT chk_worker_leave_entries_delta_days
    CHECK (
      delta_days BETWEEN -1000000::numeric AND 1000000::numeric
      AND delta_days <> 0
    )
) PARTITION BY RANGE (effective_date);
--> statement-breakpoint

ALTER TABLE worker_leave_entry_locators
  ADD CONSTRAINT fk_worker_leave_locators_fact
  FOREIGN KEY (organization_id, effective_date, entry_id)
  REFERENCES worker_leave_ledger_entries (
    organization_id,
    effective_date,
    entry_id
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE INDEX idx_worker_leave_entries_balance_rebuild
  ON worker_leave_ledger_entries (
    organization_id,
    worker_id,
    leave_type_id,
    period_key,
    effective_date,
    entry_id
  );
CREATE INDEX idx_worker_leave_entries_locator
  ON worker_leave_ledger_entries (organization_id, entry_id, effective_date);
CREATE INDEX idx_worker_leave_entries_org_engagement
  ON worker_leave_ledger_entries (organization_id, worker_engagement_id);
CREATE INDEX idx_worker_leave_entries_org_leave_type
  ON worker_leave_ledger_entries (organization_id, leave_type_id);
--> statement-breakpoint

CREATE TABLE worker_leave_reversal_links (
  organization_id text NOT NULL,
  original_entry_id bigint NOT NULL,
  original_effective_date date NOT NULL,
  reversal_entry_id bigint NOT NULL,
  reversal_effective_date date NOT NULL,
  CONSTRAINT pk_worker_leave_reversal_links
    PRIMARY KEY (organization_id, original_entry_id),
  CONSTRAINT uniq_worker_leave_reversal_links_reversal
    UNIQUE (organization_id, reversal_entry_id),
  CONSTRAINT fk_worker_leave_reversal_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_reversal_original_fact
    FOREIGN KEY (organization_id, original_effective_date, original_entry_id)
    REFERENCES worker_leave_ledger_entries (
      organization_id,
      effective_date,
      entry_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_worker_leave_reversal_original_locator
    FOREIGN KEY (organization_id, original_entry_id)
    REFERENCES worker_leave_entry_locators (organization_id, entry_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_worker_leave_reversal_reversal_fact
    FOREIGN KEY (organization_id, reversal_effective_date, reversal_entry_id)
    REFERENCES worker_leave_ledger_entries (
      organization_id,
      effective_date,
      entry_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_worker_leave_reversal_reversal_locator
    FOREIGN KEY (organization_id, reversal_entry_id)
    REFERENCES worker_leave_entry_locators (organization_id, entry_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_worker_leave_reversal_not_self
    CHECK (original_entry_id <> reversal_entry_id)
) PARTITION BY HASH (organization_id);
--> statement-breakpoint

DO $$
DECLARE
  remainder integer;
  child_name text;
BEGIN
  FOR remainder IN 0..15 LOOP
    child_name := 'worker_leave_reversal_links_h' || lpad(remainder::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF worker_leave_reversal_links FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      child_name,
      remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX idx_worker_leave_reversal_original_fact
  ON worker_leave_reversal_links (
    organization_id,
    original_effective_date,
    original_entry_id
  );
CREATE INDEX idx_worker_leave_reversal_reversal_fact
  ON worker_leave_reversal_links (
    organization_id,
    reversal_effective_date,
    reversal_entry_id
  );
--> statement-breakpoint

CREATE TABLE worker_leave_balance_projections (
  organization_id text NOT NULL,
  worker_id text NOT NULL,
  leave_type_id integer NOT NULL,
  period_key text NOT NULL,
  balance_days numeric(12, 4) NOT NULL DEFAULT 0,
  last_processed_entry_id bigint,
  last_processed_effective_date date,
  projection_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_worker_leave_balance_projections
    PRIMARY KEY (organization_id, worker_id, leave_type_id, period_key),
  CONSTRAINT fk_worker_leave_balances_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_balances_org_worker
    FOREIGN KEY (organization_id, worker_id)
    REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_balances_org_leave_type
    FOREIGN KEY (organization_id, leave_type_id)
    REFERENCES leave_types (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_worker_leave_balances_last_entry
    FOREIGN KEY (
      organization_id,
      last_processed_effective_date,
      last_processed_entry_id
    ) REFERENCES worker_leave_ledger_entries (
      organization_id,
      effective_date,
      entry_id
    ) ON DELETE RESTRICT,
  CONSTRAINT chk_worker_leave_balances_last_entry_pair
    CHECK (
      (last_processed_entry_id IS NULL) =
      (last_processed_effective_date IS NULL)
    ),
  CONSTRAINT chk_worker_leave_balances_projection_version
    CHECK (projection_version > 0),
  CONSTRAINT chk_worker_leave_balances_period_key
    CHECK (btrim(period_key) <> ''),
  CONSTRAINT chk_worker_leave_balances_balance_days
    CHECK (balance_days BETWEEN -1000000::numeric AND 1000000::numeric)
);
--> statement-breakpoint

CREATE INDEX idx_worker_leave_balances_org_leave_type
  ON worker_leave_balance_projections (organization_id, leave_type_id);
CREATE INDEX idx_worker_leave_balances_last_entry
  ON worker_leave_balance_projections (
    organization_id,
    last_processed_effective_date,
    last_processed_entry_id
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.reject_hrms_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'HRMS_APPEND_ONLY_VIOLATION: %.% is immutable',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_worker_leave_locator_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locator worker_leave_entry_locators%ROWTYPE;
  fact worker_leave_ledger_entries%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME LIKE 'worker_leave_entry_locators%' THEN
    SELECT * INTO fact
    FROM worker_leave_ledger_entries
    WHERE organization_id = NEW.organization_id
      AND effective_date = NEW.effective_date
      AND entry_id = NEW.entry_id;
    IF NOT FOUND
      OR fact.command_scope <> NEW.command_scope
      OR fact.command_id <> NEW.command_id
      OR fact.effect_ordinal <> NEW.effect_ordinal
      OR fact.source_type <> NEW.source_type
      OR fact.source_id <> NEW.source_id
      OR fact.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_LEAVE_LOCATOR_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO locator
    FROM worker_leave_entry_locators
    WHERE organization_id = NEW.organization_id
      AND entry_id = NEW.entry_id;
    IF NOT FOUND
      OR locator.effective_date <> NEW.effective_date
      OR locator.command_scope <> NEW.command_scope
      OR locator.command_id <> NEW.command_id
      OR locator.effect_ordinal <> NEW.effect_ordinal
      OR locator.source_type <> NEW.source_type
      OR locator.source_id <> NEW.source_id
      OR locator.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_LEAVE_LOCATOR_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_worker_leave_reversal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  link worker_leave_reversal_links%ROWTYPE;
  original worker_leave_ledger_entries%ROWTYPE;
  reversal worker_leave_ledger_entries%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME LIKE 'worker_leave_ledger_entries%' THEN
    IF NEW.entry_type <> 'REVERSAL' THEN
      RETURN NEW;
    END IF;
    SELECT * INTO link
    FROM worker_leave_reversal_links
    WHERE organization_id = NEW.organization_id
      AND reversal_entry_id = NEW.entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HRMS_LEAVE_REVERSAL_LINK_REQUIRED'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    link := NEW;
  END IF;

  SELECT * INTO original
  FROM worker_leave_ledger_entries
  WHERE organization_id = link.organization_id
    AND effective_date = link.original_effective_date
    AND entry_id = link.original_entry_id;
  SELECT * INTO reversal
  FROM worker_leave_ledger_entries
  WHERE organization_id = link.organization_id
    AND effective_date = link.reversal_effective_date
    AND entry_id = link.reversal_entry_id;

  IF original.entry_id IS NULL
    OR reversal.entry_id IS NULL
    OR original.entry_type = 'REVERSAL'
    OR reversal.entry_type <> 'REVERSAL'
    OR original.worker_id <> reversal.worker_id
    OR original.worker_engagement_id <> reversal.worker_engagement_id
    OR original.leave_type_id <> reversal.leave_type_id
    OR original.period_key <> reversal.period_key
    OR original.delta_days = 0
    OR reversal.delta_days <> -original.delta_days THEN
    RAISE EXCEPTION 'HRMS_LEAVE_REVERSAL_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_worker_leave_balance_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  fact worker_leave_ledger_entries%ROWTYPE;
BEGIN
  IF NEW.last_processed_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO fact
  FROM worker_leave_ledger_entries
  WHERE organization_id = NEW.organization_id
    AND effective_date = NEW.last_processed_effective_date
    AND entry_id = NEW.last_processed_entry_id;
  IF fact.entry_id IS NULL
    OR fact.worker_id <> NEW.worker_id
    OR fact.leave_type_id <> NEW.leave_type_id
    OR fact.period_key <> NEW.period_key THEN
    RAISE EXCEPTION 'HRMS_LEAVE_BALANCE_LAST_ENTRY_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER verify_worker_leave_balance_projection
  AFTER INSERT OR UPDATE ON worker_leave_balance_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION app.verify_worker_leave_balance_projection();
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
  relation_name text;
BEGIN
  FOR target IN
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'worker_leave_entry_locators'::regclass,
      'worker_leave_ledger_entries'::regclass,
      'worker_leave_reversal_links'::regclass
    )
  LOOP
    SELECT relname INTO relation_name FROM pg_class WHERE oid = target;
    IF relation_name LIKE 'worker_leave_entry_locators%'
      OR relation_name LIKE 'worker_leave_ledger_entries%' THEN
      EXECUTE format(
        'CREATE CONSTRAINT TRIGGER verify_worker_leave_locator_fact AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_worker_leave_locator_fact()',
        target
      );
    END IF;
    IF relation_name LIKE 'worker_leave_ledger_entries%'
      OR relation_name LIKE 'worker_leave_reversal_links%' THEN
      EXECUTE format(
        'CREATE CONSTRAINT TRIGGER verify_worker_leave_reversal AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_worker_leave_reversal()',
        target
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE TRIGGER reject_worker_leave_locator_mutation
  BEFORE UPDATE OR DELETE ON worker_leave_entry_locators
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_leave_fact_mutation
  BEFORE UPDATE OR DELETE ON worker_leave_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_worker_leave_reversal_mutation
  BEFORE UPDATE OR DELETE ON worker_leave_reversal_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT 'worker_leave_entry_locators'::regclass
    UNION ALL SELECT 'worker_leave_ledger_entries'::regclass
    UNION ALL SELECT 'worker_leave_reversal_links'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'worker_leave_entry_locators'::regclass,
      'worker_leave_ledger_entries'::regclass,
      'worker_leave_reversal_links'::regclass
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
  has_maintain boolean := false;
  public_column_access boolean;
BEGIN
  FOR target IN
    SELECT 'worker_leave_entry_locators'::regclass
    UNION ALL SELECT 'worker_leave_ledger_entries'::regclass
    UNION ALL SELECT 'worker_leave_reversal_links'::regclass
    UNION ALL SELECT 'worker_leave_balance_projections'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'worker_leave_entry_locators'::regclass,
      'worker_leave_ledger_entries'::regclass,
      'worker_leave_reversal_links'::regclass
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
      RAISE EXCEPTION 'HRMS_LEAVE_PUBLIC_COLUMN_PRIVILEGE: %', target
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
        EXECUTE
          'SELECT has_table_privilege($1::name, $2::oid, ''MAINTAIN'')'
          INTO has_maintain
          USING app_role, target::oid;
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
        RAISE EXCEPTION 'HRMS_LEAVE_ROLE_PRIVILEGE_NOT_REVOKED: %', target
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;
  REVOKE ALL PRIVILEGES
    ON SEQUENCE worker_leave_entry_locators_entry_id_seq
    FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE worker_leave_entry_locators_entry_id_seq FROM %I',
      app_role
    );
    IF has_sequence_privilege(
      app_role,
      'worker_leave_entry_locators_entry_id_seq',
      'USAGE'
    ) OR has_sequence_privilege(
      app_role,
      'worker_leave_entry_locators_entry_id_seq',
      'SELECT'
    ) OR has_sequence_privilege(
      app_role,
      'worker_leave_entry_locators_entry_id_seq',
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'HRMS_LEAVE_SEQUENCE_PRIVILEGE_NOT_REVOKED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
END $$;

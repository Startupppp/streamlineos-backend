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
  IF bundle_file_name <> '0003_hrms_attendance_events.sql' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_FILE_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF bundle_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_dependency_sql_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_manifest_hash !~ '^[0-9A-Fa-f]{64}$'
    OR bundle_root_migration_hash !~ '^[0-9A-Fa-f]{64}$' THEN
    RAISE EXCEPTION 'HRMS_PREFLIGHT_BUNDLE_HASH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF to_regclass('app.hrms_sql_bundle_operations') IS NULL THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_EVENTS_REQUIRES_0002' USING ERRCODE = '42P01';
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
    RAISE EXCEPTION 'HRMS_ATTENDANCE_EVENTS_CURRENT_OPERATION_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.hrms_sql_bundle_operations prior_operation
    WHERE prior_operation.bundle_id = requested_bundle_id
      AND prior_operation.file_name = '0002_hrms_leave_ledger.sql'
      AND prior_operation.sql_hash = bundle_dependency_sql_hash
      AND prior_operation.root_migration_hash = bundle_root_migration_hash
      AND prior_operation.state = 'COMPLETE'
      AND prior_operation.database_name = current_database()
      AND prior_operation.database_role = current_user
      AND prior_operation.server_version_num = current_setting('server_version_num')::integer
  ) THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_EVENTS_REQUIRES_COMPLETE_0002_OPERATION' USING ERRCODE = '55000';
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

ALTER TABLE attendance
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS worker_engagement_id text;
--> statement-breakpoint

ALTER TABLE attendance
  ADD CONSTRAINT chk_attendance_canonical_subject_pair
    CHECK ((worker_id IS NULL) = (worker_engagement_id IS NULL)) NOT VALID,
  ADD CONSTRAINT fk_attendance_org_worker
    FOREIGN KEY (org_id, worker_id)
    REFERENCES workers (organization_id, worker_id)
    ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT fk_attendance_worker_engagement
    FOREIGN KEY (org_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_attendance_org_worker_date
  ON attendance (org_id, worker_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_org_engagement_date
  ON attendance (org_id, worker_engagement_id, date);
--> statement-breakpoint

CREATE TYPE attendance_event_kind AS ENUM (
  'CHECK_IN',
  'CHECK_OUT',
  'BREAK_START',
  'BREAK_END',
  'AUTO_CHECKOUT',
  'CORRECTION'
);
CREATE TYPE attendance_event_source AS ENUM (
  'SELF_SERVICE',
  'HR_ADMIN',
  'BIOMETRIC_DEVICE',
  'REGULARIZATION',
  'IMPORT',
  'MIGRATION',
  'SYSTEM'
);
CREATE TYPE attendance_correction_action AS ENUM ('VOID', 'REPLACE');
CREATE TYPE attendance_correction_replacement_kind AS ENUM (
  'CHECK_IN',
  'CHECK_OUT',
  'BREAK_START',
  'BREAK_END',
  'AUTO_CHECKOUT'
);
CREATE TYPE attendance_accuracy_bucket AS ENUM (
  'LE_10_M',
  'GT_10_LE_50_M',
  'GT_50_LE_100_M',
  'GT_100_M',
  'UNKNOWN'
);
CREATE TYPE attendance_distance_bucket AS ENUM (
  'INSIDE_RADIUS',
  'OUTSIDE_LE_50_M',
  'OUTSIDE_GT_50_M',
  'UNKNOWN'
);
CREATE TYPE attendance_session_state AS ENUM (
  'WORKING',
  'ON_BREAK',
  'CLOSED'
);
--> statement-breakpoint

CREATE TABLE attendance_event_locators (
  organization_id text NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  business_date date NOT NULL,
  command_scope text NOT NULL,
  command_id text NOT NULL,
  effect_ordinal integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_event_locators
    PRIMARY KEY (organization_id, event_id),
  CONSTRAINT uniq_attendance_event_locators_org_event_date
    UNIQUE (organization_id, event_id, business_date),
  CONSTRAINT uniq_attendance_event_locators_command
    UNIQUE (organization_id, command_scope, command_id, effect_ordinal),
  CONSTRAINT uniq_attendance_event_locators_source
    UNIQUE (organization_id, source_type, source_id, source_ordinal),
  CONSTRAINT fk_attendance_event_locators_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_attendance_event_locators_ordinals
    CHECK (effect_ordinal >= 0 AND source_ordinal >= 0),
  CONSTRAINT chk_attendance_event_locators_keys
    CHECK (
      btrim(command_scope) <> '' AND btrim(command_id) <> ''
      AND btrim(source_type) <> '' AND btrim(source_id) <> ''
    )
) PARTITION BY HASH (organization_id);
--> statement-breakpoint

DO $$
DECLARE
  remainder integer;
  child_name text;
BEGIN
  FOR remainder IN 0..15 LOOP
    child_name := 'attendance_event_locators_h'
      || lpad(remainder::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF attendance_event_locators FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      child_name,
      remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX idx_attendance_event_locators_org_date
  ON attendance_event_locators (organization_id, business_date);
--> statement-breakpoint

CREATE TABLE attendance_events (
  organization_id text NOT NULL,
  business_date date NOT NULL,
  event_id bigint NOT NULL,
  worker_id text NOT NULL,
  worker_engagement_id text NOT NULL,
  event_kind attendance_event_kind NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  organization_timezone text NOT NULL,
  event_source attendance_event_source NOT NULL,
  command_scope text NOT NULL,
  command_id text NOT NULL,
  effect_ordinal integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_ordinal integer NOT NULL,
  actor_membership_id integer,
  actor_user_id text,
  migration_batch_id text,
  geofence_id integer,
  geofence_passed boolean,
  accuracy_bucket attendance_accuracy_bucket,
  distance_bucket attendance_distance_bucket,
  corrects_business_date date,
  corrects_event_id bigint,
  correction_action attendance_correction_action,
  replacement_event_kind attendance_correction_replacement_kind,
  replacement_occurred_at timestamptz,
  correction_reason_code text,
  CONSTRAINT pk_attendance_events
    PRIMARY KEY (organization_id, business_date, event_id),
  CONSTRAINT fk_attendance_events_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_events_locator
    FOREIGN KEY (organization_id, event_id, business_date)
    REFERENCES attendance_event_locators (
      organization_id,
      event_id,
      business_date
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_attendance_events_worker
    FOREIGN KEY (organization_id, worker_id)
    REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_events_worker_engagement
    FOREIGN KEY (organization_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_events_geofence
    FOREIGN KEY (organization_id, geofence_id)
    REFERENCES geofences (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_events_correction_target
    FOREIGN KEY (
      organization_id,
      corrects_business_date,
      corrects_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_attendance_events_timezone
    CHECK (btrim(organization_timezone) <> ''),
  CONSTRAINT chk_attendance_events_command_source
    CHECK (
      btrim(command_scope) <> '' AND btrim(command_id) <> ''
      AND effect_ordinal >= 0
      AND btrim(source_type) <> '' AND btrim(source_id) <> ''
      AND source_ordinal >= 0
      AND (migration_batch_id IS NULL OR btrim(migration_batch_id) <> '')
    ),
  CONSTRAINT chk_attendance_events_geofence_pair
    CHECK ((geofence_id IS NULL) = (geofence_passed IS NULL)),
  CONSTRAINT chk_attendance_events_correction_shape
    CHECK (
      (
        event_kind = 'CORRECTION'
        AND corrects_business_date IS NOT NULL
        AND corrects_event_id IS NOT NULL
        AND correction_action IS NOT NULL
        AND correction_reason_code IS NOT NULL
        AND btrim(correction_reason_code) <> ''
      ) OR (
        event_kind <> 'CORRECTION'
        AND corrects_business_date IS NULL
        AND corrects_event_id IS NULL
        AND correction_action IS NULL
        AND replacement_event_kind IS NULL
        AND replacement_occurred_at IS NULL
        AND correction_reason_code IS NULL
      )
    ),
  CONSTRAINT chk_attendance_events_replacement_shape
    CHECK (
      (
        correction_action = 'REPLACE'
        AND replacement_event_kind IS NOT NULL
        AND replacement_occurred_at IS NOT NULL
      ) OR (
        correction_action = 'VOID'
        AND replacement_event_kind IS NULL
        AND replacement_occurred_at IS NULL
      ) OR (
        correction_action IS NULL
        AND replacement_event_kind IS NULL
        AND replacement_occurred_at IS NULL
      )
    ),
  CONSTRAINT chk_attendance_events_not_self_correction
    CHECK (
      corrects_event_id IS NULL
      OR corrects_event_id <> event_id
      OR corrects_business_date <> business_date
    )
) PARTITION BY RANGE (business_date);
--> statement-breakpoint

ALTER TABLE attendance_event_locators
  ADD CONSTRAINT fk_attendance_event_locators_fact
  FOREIGN KEY (organization_id, business_date, event_id)
  REFERENCES attendance_events (organization_id, business_date, event_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE INDEX idx_attendance_events_org_worker_date
  ON attendance_events (organization_id, worker_id, business_date);
CREATE INDEX idx_attendance_events_org_engagement_date
  ON attendance_events (
    organization_id,
    worker_engagement_id,
    business_date
  );
CREATE INDEX idx_attendance_events_org_kind_date
  ON attendance_events (organization_id, event_kind, business_date);
CREATE INDEX idx_attendance_events_correction_target
  ON attendance_events (
    organization_id,
    corrects_business_date,
    corrects_event_id
  );
--> statement-breakpoint

CREATE TABLE attendance_correction_links (
  organization_id text NOT NULL,
  original_business_date date NOT NULL,
  original_event_id bigint NOT NULL,
  correction_business_date date NOT NULL,
  correction_event_id bigint NOT NULL,
  CONSTRAINT pk_attendance_correction_links
    PRIMARY KEY (organization_id, original_event_id),
  CONSTRAINT uniq_attendance_correction_links_correction
    UNIQUE (organization_id, correction_event_id),
  CONSTRAINT fk_attendance_correction_links_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_correction_links_original_locator
    FOREIGN KEY (organization_id, original_event_id)
    REFERENCES attendance_event_locators (organization_id, event_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_attendance_correction_links_correction_locator
    FOREIGN KEY (organization_id, correction_event_id)
    REFERENCES attendance_event_locators (organization_id, event_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_attendance_correction_links_original_fact
    FOREIGN KEY (
      organization_id,
      original_business_date,
      original_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_attendance_correction_links_correction_fact
    FOREIGN KEY (
      organization_id,
      correction_business_date,
      correction_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_attendance_correction_links_not_self
    CHECK (original_event_id <> correction_event_id)
) PARTITION BY HASH (organization_id);
--> statement-breakpoint

DO $$
DECLARE
  remainder integer;
  child_name text;
BEGIN
  FOR remainder IN 0..15 LOOP
    child_name := 'attendance_correction_links_h'
      || lpad(remainder::text, 2, '0');
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF attendance_correction_links FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      child_name,
      remainder
    );
  END LOOP;
END $$;
--> statement-breakpoint

CREATE INDEX idx_attendance_correction_links_original_fact
  ON attendance_correction_links (
    organization_id,
    original_business_date,
    original_event_id
  );
CREATE INDEX idx_attendance_correction_links_correction_fact
  ON attendance_correction_links (
    organization_id,
    correction_business_date,
    correction_event_id
  );
--> statement-breakpoint

CREATE TABLE attendance_event_evidence (
  organization_id text NOT NULL,
  business_date date NOT NULL,
  evidence_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  event_id bigint NOT NULL,
  encrypted_coordinates text NOT NULL,
  wrapped_data_key text NOT NULL,
  kms_key_id text NOT NULL,
  kms_key_version text NOT NULL,
  encryption_version integer NOT NULL,
  coordinate_decimal_places integer NOT NULL,
  capture_source attendance_event_source NOT NULL,
  device_fingerprint_hash text,
  captured_at timestamptz NOT NULL,
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_event_evidence
    PRIMARY KEY (organization_id, business_date, evidence_id),
  CONSTRAINT uniq_attendance_event_evidence_event
    UNIQUE (organization_id, business_date, event_id),
  CONSTRAINT fk_attendance_event_evidence_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_event_evidence_event
    FOREIGN KEY (organization_id, business_date, event_id)
    REFERENCES attendance_events (organization_id, business_date, event_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_attendance_event_evidence_encryption
    CHECK (
      encryption_version > 0
      AND btrim(encrypted_coordinates) <> ''
      AND btrim(wrapped_data_key) <> ''
      AND btrim(kms_key_id) <> ''
      AND btrim(kms_key_version) <> ''
    ),
  CONSTRAINT chk_attendance_event_evidence_precision
    CHECK (coordinate_decimal_places BETWEEN 0 AND 4),
  CONSTRAINT chk_attendance_event_evidence_retention
    CHECK (
      retention_expires_at > captured_at
      AND retention_expires_at <= captured_at + interval '30 days'
    )
) PARTITION BY RANGE (business_date);
--> statement-breakpoint

CREATE INDEX idx_attendance_event_evidence_expiry
  ON attendance_event_evidence (organization_id, retention_expires_at);
--> statement-breakpoint

CREATE TABLE attendance_evidence_legal_holds (
  organization_id text NOT NULL,
  business_date date NOT NULL,
  evidence_id bigint NOT NULL,
  case_id text NOT NULL,
  reason_code text NOT NULL,
  approved_by_membership_id integer NOT NULL,
  second_approver_membership_id integer NOT NULL,
  approved_at timestamptz NOT NULL,
  review_due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_evidence_legal_holds
    PRIMARY KEY (organization_id, business_date, evidence_id),
  CONSTRAINT fk_attendance_evidence_legal_holds_evidence
    FOREIGN KEY (organization_id, business_date, evidence_id)
    REFERENCES attendance_event_evidence (
      organization_id,
      business_date,
      evidence_id
    ) ON DELETE CASCADE,
  CONSTRAINT chk_attendance_evidence_legal_holds_approvers
    CHECK (approved_by_membership_id <> second_approver_membership_id),
  CONSTRAINT chk_attendance_evidence_legal_holds_text
    CHECK (btrim(case_id) <> '' AND btrim(reason_code) <> ''),
  CONSTRAINT chk_attendance_evidence_legal_holds_window
    CHECK (
      review_due_at > approved_at
      AND review_due_at <= approved_at + interval '90 days'
      AND expires_at >= review_due_at
    ),
  CONSTRAINT chk_attendance_evidence_legal_holds_version
    CHECK (row_version > 0)
);
--> statement-breakpoint

CREATE INDEX idx_attendance_evidence_legal_holds_review
  ON attendance_evidence_legal_holds (organization_id, review_due_at);
--> statement-breakpoint

CREATE TABLE attendance_session_projections (
  organization_id text NOT NULL,
  session_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  business_date date NOT NULL,
  worker_id text NOT NULL,
  worker_engagement_id text NOT NULL,
  state attendance_session_state NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  break_started_at timestamptz,
  worked_minutes integer NOT NULL DEFAULT 0,
  break_minutes integer NOT NULL DEFAULT 0,
  opened_event_business_date date NOT NULL,
  opened_event_id bigint NOT NULL,
  last_event_business_date date NOT NULL,
  last_event_id bigint NOT NULL,
  projection_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_session_projections
    PRIMARY KEY (organization_id, session_id),
  CONSTRAINT fk_attendance_session_projections_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_session_projections_worker
    FOREIGN KEY (organization_id, worker_id)
    REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_session_worker_engagement
    FOREIGN KEY (organization_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_session_projections_opened_event
    FOREIGN KEY (
      organization_id,
      opened_event_business_date,
      opened_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_session_projections_last_event
    FOREIGN KEY (
      organization_id,
      last_event_business_date,
      last_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT,
  CONSTRAINT chk_attendance_session_projections_state
    CHECK (
      (state = 'CLOSED' AND closed_at IS NOT NULL)
      OR (state <> 'CLOSED' AND closed_at IS NULL)
    ),
  CONSTRAINT chk_attendance_session_projections_break
    CHECK (
      (state = 'ON_BREAK' AND break_started_at IS NOT NULL)
      OR (state <> 'ON_BREAK' AND break_started_at IS NULL)
    ),
  CONSTRAINT chk_attendance_session_projections_times
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT chk_attendance_session_projections_totals
    CHECK (
      worked_minutes >= 0 AND break_minutes >= 0
      AND projection_version > 0
    ),
  CONSTRAINT chk_attendance_session_projections_event_dates
    CHECK (
      opened_event_business_date = business_date
      AND last_event_business_date = business_date
    )
);
--> statement-breakpoint

CREATE UNIQUE INDEX uniq_attendance_session_projections_open_worker
  ON attendance_session_projections (organization_id, worker_id)
  WHERE closed_at IS NULL;
CREATE INDEX idx_attendance_session_projections_worker_date
  ON attendance_session_projections (
    organization_id,
    worker_id,
    business_date
  );
CREATE INDEX idx_attendance_session_projections_state
  ON attendance_session_projections (organization_id, state);
--> statement-breakpoint

CREATE TABLE attendance_daily_projections (
  organization_id text NOT NULL,
  business_date date NOT NULL,
  worker_id text NOT NULL,
  worker_engagement_id text NOT NULL,
  first_check_in_at timestamptz,
  last_check_out_at timestamptz,
  worked_minutes integer NOT NULL DEFAULT 0,
  break_minutes integer NOT NULL DEFAULT 0,
  overtime_minutes integer NOT NULL DEFAULT 0,
  session_count integer NOT NULL DEFAULT 0,
  has_open_session boolean NOT NULL DEFAULT false,
  last_event_business_date date NOT NULL,
  last_event_id bigint NOT NULL,
  projection_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_attendance_daily_projections
    PRIMARY KEY (organization_id, business_date, worker_id),
  CONSTRAINT fk_attendance_daily_projections_organization
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_daily_projections_worker
    FOREIGN KEY (organization_id, worker_id)
    REFERENCES workers (organization_id, worker_id) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_daily_worker_engagement
    FOREIGN KEY (organization_id, worker_id, worker_engagement_id)
    REFERENCES worker_engagements (
      organization_id,
      worker_id,
      worker_engagement_id
    ) ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_daily_projections_last_event
    FOREIGN KEY (
      organization_id,
      last_event_business_date,
      last_event_id
    ) REFERENCES attendance_events (
      organization_id,
      business_date,
      event_id
    ) ON DELETE RESTRICT,
  CONSTRAINT chk_attendance_daily_projections_totals
    CHECK (
      worked_minutes >= 0 AND break_minutes >= 0
      AND overtime_minutes >= 0 AND session_count >= 0
      AND projection_version > 0
    ),
  CONSTRAINT chk_attendance_daily_projections_times
    CHECK (
      first_check_in_at IS NULL OR last_check_out_at IS NULL
      OR last_check_out_at >= first_check_in_at
    ),
  CONSTRAINT chk_attendance_daily_projections_event_date
    CHECK (last_event_business_date = business_date)
);
--> statement-breakpoint

CREATE INDEX idx_attendance_daily_projections_worker_date
  ON attendance_daily_projections (
    organization_id,
    worker_id,
    business_date
  );
CREATE INDEX idx_attendance_daily_projections_date
  ON attendance_daily_projections (organization_id, business_date);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_attendance_locator_fact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locator attendance_event_locators%ROWTYPE;
  fact attendance_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME LIKE 'attendance_event_locators%' THEN
    SELECT * INTO fact
    FROM attendance_events
    WHERE organization_id = NEW.organization_id
      AND business_date = NEW.business_date
      AND event_id = NEW.event_id;
    IF NOT FOUND
      OR fact.command_scope <> NEW.command_scope
      OR fact.command_id <> NEW.command_id
      OR fact.effect_ordinal <> NEW.effect_ordinal
      OR fact.source_type <> NEW.source_type
      OR fact.source_id <> NEW.source_id
      OR fact.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_ATTENDANCE_LOCATOR_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO locator
    FROM attendance_event_locators
    WHERE organization_id = NEW.organization_id
      AND event_id = NEW.event_id;
    IF NOT FOUND
      OR locator.business_date <> NEW.business_date
      OR locator.command_scope <> NEW.command_scope
      OR locator.command_id <> NEW.command_id
      OR locator.effect_ordinal <> NEW.effect_ordinal
      OR locator.source_type <> NEW.source_type
      OR locator.source_id <> NEW.source_id
      OR locator.source_ordinal <> NEW.source_ordinal THEN
      RAISE EXCEPTION 'HRMS_ATTENDANCE_LOCATOR_FACT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_attendance_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  link attendance_correction_links%ROWTYPE;
  target attendance_events%ROWTYPE;
BEGIN
  IF NEW.event_kind <> 'CORRECTION' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO target
  FROM attendance_events
  WHERE organization_id = NEW.organization_id
    AND business_date = NEW.corrects_business_date
    AND event_id = NEW.corrects_event_id;
  SELECT * INTO link
  FROM attendance_correction_links
  WHERE organization_id = NEW.organization_id
    AND correction_business_date = NEW.business_date
    AND correction_event_id = NEW.event_id;
  IF link.correction_event_id IS NULL
    OR link.original_business_date <> NEW.corrects_business_date
    OR link.original_event_id <> NEW.corrects_event_id
    OR target.event_id IS NULL
    OR target.event_kind = 'CORRECTION'
    OR target.worker_id <> NEW.worker_id
    OR target.worker_engagement_id <> NEW.worker_engagement_id THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_CORRECTION_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_attendance_correction_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  original attendance_events%ROWTYPE;
  correction attendance_events%ROWTYPE;
BEGIN
  SELECT * INTO original
  FROM attendance_events
  WHERE organization_id = NEW.organization_id
    AND business_date = NEW.original_business_date
    AND event_id = NEW.original_event_id;
  SELECT * INTO correction
  FROM attendance_events
  WHERE organization_id = NEW.organization_id
    AND business_date = NEW.correction_business_date
    AND event_id = NEW.correction_event_id;
  IF original.event_id IS NULL
    OR correction.event_id IS NULL
    OR original.event_kind = 'CORRECTION'
    OR correction.event_kind <> 'CORRECTION'
    OR correction.corrects_business_date <> NEW.original_business_date
    OR correction.corrects_event_id <> NEW.original_event_id
    OR original.worker_id <> correction.worker_id
    OR original.worker_engagement_id <> correction.worker_engagement_id THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_CORRECTION_LINK_INVALID'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.verify_attendance_projection_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  opened attendance_events%ROWTYPE;
  latest attendance_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'attendance_session_projections' THEN
    SELECT * INTO opened
    FROM attendance_events
    WHERE organization_id = NEW.organization_id
      AND business_date = NEW.opened_event_business_date
      AND event_id = NEW.opened_event_id;
    IF opened.event_id IS NULL
      OR opened.worker_id <> NEW.worker_id
      OR opened.worker_engagement_id <> NEW.worker_engagement_id THEN
      RAISE EXCEPTION 'HRMS_ATTENDANCE_SESSION_OPEN_EVENT_MISMATCH'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT * INTO latest
  FROM attendance_events
  WHERE organization_id = NEW.organization_id
    AND business_date = NEW.last_event_business_date
    AND event_id = NEW.last_event_id;
  IF latest.event_id IS NULL
    OR latest.worker_id <> NEW.worker_id
    OR latest.worker_engagement_id <> NEW.worker_engagement_id THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_LAST_EVENT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER verify_attendance_session_projection_events
  AFTER INSERT OR UPDATE ON attendance_session_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_attendance_projection_events();
CREATE CONSTRAINT TRIGGER verify_attendance_daily_projection_events
  AFTER INSERT OR UPDATE ON attendance_daily_projections
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.verify_attendance_projection_events();
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
      'attendance_event_locators'::regclass,
      'attendance_events'::regclass,
      'attendance_correction_links'::regclass
    )
  LOOP
    SELECT relname INTO relation_name FROM pg_class WHERE oid = target;
    IF relation_name LIKE 'attendance_event_locators_%'
      OR relation_name LIKE 'attendance_events_%' THEN
      EXECUTE format(
        'CREATE CONSTRAINT TRIGGER verify_attendance_locator_fact AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_attendance_locator_fact()',
        target
      );
    END IF;
    IF relation_name LIKE 'attendance_events_%' THEN
      EXECUTE format(
        'CREATE CONSTRAINT TRIGGER verify_attendance_correction AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_attendance_correction()',
        target
      );
    END IF;
    IF relation_name LIKE 'attendance_correction_links_%' THEN
      EXECUTE format(
        'CREATE CONSTRAINT TRIGGER verify_attendance_correction_link AFTER INSERT ON %s DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.verify_attendance_correction_link()',
        target
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.reject_attendance_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_EVIDENCE_IMMUTABLE'
      USING ERRCODE = '55000';
  END IF;
  IF current_setting('app.hrms_retention_purge', true) IS DISTINCT FROM 'on'
    OR OLD.retention_expires_at > clock_timestamp()
    OR EXISTS (
      SELECT 1
      FROM attendance_evidence_legal_holds hold
      WHERE hold.organization_id = OLD.organization_id
        AND hold.business_date = OLD.business_date
        AND hold.evidence_id = OLD.evidence_id
        AND hold.expires_at > clock_timestamp()
    ) THEN
    RAISE EXCEPTION 'HRMS_ATTENDANCE_EVIDENCE_RETENTION_BLOCKED'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER reject_attendance_event_locator_mutation
  BEFORE UPDATE OR DELETE ON attendance_event_locators
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_attendance_event_mutation
  BEFORE UPDATE OR DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER reject_attendance_correction_link_mutation
  BEFORE UPDATE OR DELETE ON attendance_correction_links
  FOR EACH ROW EXECUTE FUNCTION app.reject_hrms_append_only_mutation();
CREATE TRIGGER guard_attendance_event_evidence_mutation
  BEFORE UPDATE OR DELETE ON attendance_event_evidence
  FOR EACH ROW EXECUTE FUNCTION app.reject_attendance_evidence_mutation();
--> statement-breakpoint

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT 'attendance_event_locators'::regclass
    UNION ALL SELECT 'attendance_events'::regclass
    UNION ALL SELECT 'attendance_correction_links'::regclass
    UNION ALL SELECT 'attendance_event_evidence'::regclass
    UNION ALL SELECT 'attendance_evidence_legal_holds'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'attendance_event_locators'::regclass,
      'attendance_events'::regclass,
      'attendance_correction_links'::regclass,
      'attendance_event_evidence'::regclass
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
    SELECT 'attendance_event_locators'::regclass
    UNION ALL SELECT 'attendance_events'::regclass
    UNION ALL SELECT 'attendance_correction_links'::regclass
    UNION ALL SELECT 'attendance_event_evidence'::regclass
    UNION ALL SELECT 'attendance_evidence_legal_holds'::regclass
    UNION ALL SELECT 'attendance_session_projections'::regclass
    UNION ALL SELECT 'attendance_daily_projections'::regclass
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent IN (
      'attendance_event_locators'::regclass,
      'attendance_events'::regclass,
      'attendance_correction_links'::regclass,
      'attendance_event_evidence'::regclass
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
      RAISE EXCEPTION 'HRMS_ATTENDANCE_PUBLIC_COLUMN_PRIVILEGE: %', target
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
        RAISE EXCEPTION 'HRMS_ATTENDANCE_ROLE_PRIVILEGE_NOT_REVOKED: %', target
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON SEQUENCE attendance_event_locators_event_id_seq,
      attendance_event_evidence_evidence_id_seq,
      attendance_session_projections_session_id_seq
    FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE attendance_event_locators_event_id_seq, attendance_event_evidence_evidence_id_seq, attendance_session_projections_session_id_seq FROM %I',
      app_role
    );
    IF has_sequence_privilege(
      app_role,
      'attendance_event_locators_event_id_seq',
      'USAGE'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_event_evidence_evidence_id_seq',
      'USAGE'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_session_projections_session_id_seq',
      'USAGE'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_event_locators_event_id_seq',
      'SELECT'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_event_evidence_evidence_id_seq',
      'SELECT'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_session_projections_session_id_seq',
      'SELECT'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_event_locators_event_id_seq',
      'UPDATE'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_event_evidence_evidence_id_seq',
      'UPDATE'
    ) OR has_sequence_privilege(
      app_role,
      'attendance_session_projections_session_id_seq',
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'HRMS_ATTENDANCE_SEQUENCE_PRIVILEGE_NOT_REVOKED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
END $$;

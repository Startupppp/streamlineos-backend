SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regprocedure('app.current_org_id()') IS NULL THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_CURRENT_ORG_FUNCTION_MISSING';
  END IF;
  IF to_regclass('public.hr_employee_sensitive_fields') IS NULL
    OR to_regclass('public.documents') IS NULL
    OR to_regclass('public.onboarding_tasks') IS NULL
    OR to_regclass('public.terminations') IS NULL THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_PARENT_TABLE_MISSING';
  END IF;
END
$preflight$;

CREATE TABLE hr_employee_sensitive_disciplinary_records (
  organization_id text NOT NULL,
  disciplinary_record_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sensitive_fields_id integer NOT NULL,
  source_ordinal integer NOT NULL,
  record_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_sensitive_disciplinary_records
    PRIMARY KEY (organization_id, disciplinary_record_id),
  CONSTRAINT uniq_hr_sensitive_disciplinary_parent_order
    UNIQUE (organization_id, sensitive_fields_id, source_ordinal),
  CONSTRAINT chk_hr_sensitive_disciplinary_payload
    CHECK (source_ordinal >= 0 AND jsonb_typeof(record_payload) = 'object')
);

CREATE TABLE hr_employee_sensitive_grievance_records (
  organization_id text NOT NULL,
  grievance_record_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sensitive_fields_id integer NOT NULL,
  source_ordinal integer NOT NULL,
  record_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_sensitive_grievance_records
    PRIMARY KEY (organization_id, grievance_record_id),
  CONSTRAINT uniq_hr_sensitive_grievance_parent_order
    UNIQUE (organization_id, sensitive_fields_id, source_ordinal),
  CONSTRAINT chk_hr_sensitive_grievance_payload
    CHECK (source_ordinal >= 0 AND jsonb_typeof(record_payload) = 'object')
);

CREATE TABLE hr_document_tags (
  organization_id text NOT NULL,
  document_tag_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  document_id integer NOT NULL,
  tag text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_hr_document_tags PRIMARY KEY (organization_id, document_tag_id),
  CONSTRAINT uniq_hr_document_tags_parent_tag
    UNIQUE (organization_id, document_id, tag),
  CONSTRAINT uniq_hr_document_tags_parent_order
    UNIQUE (organization_id, document_id, sort_order),
  CONSTRAINT chk_hr_document_tags_value
    CHECK (btrim(tag) <> '' AND sort_order >= 0)
);

CREATE TABLE onboarding_task_dependencies (
  organization_id text NOT NULL,
  onboarding_task_dependency_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  onboarding_task_id integer NOT NULL,
  prerequisite_task_id integer NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_onboarding_task_dependencies
    PRIMARY KEY (organization_id, onboarding_task_dependency_id),
  CONSTRAINT uniq_onboarding_task_dependencies_pair
    UNIQUE (organization_id, onboarding_task_id, prerequisite_task_id),
  CONSTRAINT uniq_onboarding_task_dependencies_order
    UNIQUE (organization_id, onboarding_task_id, sort_order),
  CONSTRAINT chk_onboarding_task_dependencies_link
    CHECK (onboarding_task_id <> prerequisite_task_id AND sort_order >= 0)
);

CREATE TABLE termination_reasons (
  organization_id text NOT NULL,
  termination_reason_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  termination_id integer NOT NULL,
  reason text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_termination_reasons
    PRIMARY KEY (organization_id, termination_reason_id),
  CONSTRAINT uniq_termination_reasons_parent_reason
    UNIQUE (organization_id, termination_id, reason),
  CONSTRAINT uniq_termination_reasons_parent_order
    UNIQUE (organization_id, termination_id, sort_order),
  CONSTRAINT chk_termination_reasons_value
    CHECK (btrim(reason) <> '' AND sort_order >= 0)
);

CREATE TABLE termination_supporting_documents (
  organization_id text NOT NULL,
  termination_supporting_document_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  termination_id integer NOT NULL,
  legacy_url text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_termination_supporting_documents
    PRIMARY KEY (organization_id, termination_supporting_document_id),
  CONSTRAINT uniq_termination_supporting_documents_url
    UNIQUE (organization_id, termination_id, legacy_url),
  CONSTRAINT uniq_termination_supporting_documents_order
    UNIQUE (organization_id, termination_id, sort_order),
  CONSTRAINT chk_termination_supporting_documents_value
    CHECK (btrim(legacy_url) <> '' AND sort_order >= 0)
);

ALTER TABLE hr_employee_sensitive_disciplinary_records
  ADD CONSTRAINT fk_hr_sensitive_disciplinary_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE hr_employee_sensitive_disciplinary_records
  ADD CONSTRAINT fk_hr_sensitive_disciplinary_parent
  FOREIGN KEY (organization_id, sensitive_fields_id)
  REFERENCES hr_employee_sensitive_fields(org_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE hr_employee_sensitive_grievance_records
  ADD CONSTRAINT fk_hr_sensitive_grievance_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE hr_employee_sensitive_grievance_records
  ADD CONSTRAINT fk_hr_sensitive_grievance_parent
  FOREIGN KEY (organization_id, sensitive_fields_id)
  REFERENCES hr_employee_sensitive_fields(org_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE hr_document_tags
  ADD CONSTRAINT fk_hr_document_tags_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE hr_document_tags
  ADD CONSTRAINT fk_hr_document_tags_parent
  FOREIGN KEY (organization_id, document_id)
  REFERENCES documents(org_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE onboarding_task_dependencies
  ADD CONSTRAINT fk_onboarding_task_dependencies_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE onboarding_task_dependencies
  ADD CONSTRAINT fk_onboarding_task_dependencies_task
  FOREIGN KEY (organization_id, onboarding_task_id)
  REFERENCES onboarding_tasks(org_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE onboarding_task_dependencies
  ADD CONSTRAINT fk_onboarding_task_dependencies_prerequisite
  FOREIGN KEY (organization_id, prerequisite_task_id)
  REFERENCES onboarding_tasks(org_id, id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE termination_reasons
  ADD CONSTRAINT fk_termination_reasons_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE termination_reasons
  ADD CONSTRAINT fk_termination_reasons_parent
  FOREIGN KEY (organization_id, termination_id)
  REFERENCES terminations(org_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE termination_supporting_documents
  ADD CONSTRAINT fk_termination_supporting_documents_org
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE termination_supporting_documents
  ADD CONSTRAINT fk_termination_supporting_documents_parent
  FOREIGN KEY (organization_id, termination_id)
  REFERENCES terminations(org_id, id)
  ON DELETE CASCADE NOT VALID;

ALTER TABLE hr_employee_sensitive_disciplinary_records
  VALIDATE CONSTRAINT fk_hr_sensitive_disciplinary_org;
ALTER TABLE hr_employee_sensitive_disciplinary_records
  VALIDATE CONSTRAINT fk_hr_sensitive_disciplinary_parent;
ALTER TABLE hr_employee_sensitive_grievance_records
  VALIDATE CONSTRAINT fk_hr_sensitive_grievance_org;
ALTER TABLE hr_employee_sensitive_grievance_records
  VALIDATE CONSTRAINT fk_hr_sensitive_grievance_parent;
ALTER TABLE hr_document_tags VALIDATE CONSTRAINT fk_hr_document_tags_org;
ALTER TABLE hr_document_tags VALIDATE CONSTRAINT fk_hr_document_tags_parent;
ALTER TABLE onboarding_task_dependencies
  VALIDATE CONSTRAINT fk_onboarding_task_dependencies_org;
ALTER TABLE onboarding_task_dependencies
  VALIDATE CONSTRAINT fk_onboarding_task_dependencies_task;
ALTER TABLE onboarding_task_dependencies
  VALIDATE CONSTRAINT fk_onboarding_task_dependencies_prerequisite;
ALTER TABLE termination_reasons VALIDATE CONSTRAINT fk_termination_reasons_org;
ALTER TABLE termination_reasons VALIDATE CONSTRAINT fk_termination_reasons_parent;
ALTER TABLE termination_supporting_documents
  VALIDATE CONSTRAINT fk_termination_supporting_documents_org;
ALTER TABLE termination_supporting_documents
  VALIDATE CONSTRAINT fk_termination_supporting_documents_parent;

CREATE INDEX idx_hr_sensitive_disciplinary_parent
  ON hr_employee_sensitive_disciplinary_records
  (organization_id, sensitive_fields_id, source_ordinal);
CREATE INDEX idx_hr_sensitive_grievance_parent
  ON hr_employee_sensitive_grievance_records
  (organization_id, sensitive_fields_id, source_ordinal);
CREATE INDEX idx_hr_document_tags_parent
  ON hr_document_tags (organization_id, document_id, sort_order);
CREATE INDEX idx_hr_document_tags_lookup
  ON hr_document_tags (organization_id, tag);
CREATE INDEX idx_onboarding_task_dependencies_task
  ON onboarding_task_dependencies
  (organization_id, onboarding_task_id, sort_order);
CREATE INDEX idx_onboarding_task_dependencies_prerequisite
  ON onboarding_task_dependencies (organization_id, prerequisite_task_id);
CREATE INDEX idx_termination_reasons_parent
  ON termination_reasons (organization_id, termination_id, sort_order);
CREATE INDEX idx_termination_supporting_documents_parent
  ON termination_supporting_documents
  (organization_id, termination_id, sort_order);

ALTER TABLE hr_employee_sensitive_disciplinary_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_sensitive_grievance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_document_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE termination_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE termination_supporting_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON hr_employee_sensitive_disciplinary_records
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hr_employee_sensitive_grievance_records
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON hr_document_tags
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON onboarding_task_dependencies
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON termination_reasons
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY tenant_isolation ON termination_supporting_documents
  USING (organization_id = app.current_org_id())
  WITH CHECK (organization_id = app.current_org_id());

REVOKE ALL ON hr_employee_sensitive_disciplinary_records FROM PUBLIC;
REVOKE ALL ON hr_employee_sensitive_grievance_records FROM PUBLIC;
REVOKE ALL ON hr_document_tags FROM PUBLIC;
REVOKE ALL ON onboarding_task_dependencies FROM PUBLIC;
REVOKE ALL ON termination_reasons FROM PUBLIC;
REVOKE ALL ON termination_supporting_documents FROM PUBLIC;

DO $application_grants$
DECLARE
  application_role text := coalesce(
    nullif(current_setting('app.bootstrap_role', true), ''),
    'streamline_app'
  );
  relation_name text;
  identity_sequence text;
  relation_names text[] := ARRAY[
    'hr_employee_sensitive_disciplinary_records',
    'hr_employee_sensitive_grievance_records',
    'hr_document_tags',
    'onboarding_task_dependencies',
    'termination_reasons',
    'termination_supporting_documents'
  ];
  identity_columns text[] := ARRAY[
    'disciplinary_record_id',
    'grievance_record_id',
    'document_tag_id',
    'onboarding_task_dependency_id',
    'termination_reason_id',
    'termination_supporting_document_id'
  ];
  relation_position integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = application_role) THEN
    RAISE EXCEPTION 'HR_RELATIONAL_NORMALIZATION_APPLICATION_ROLE_MISSING';
  END IF;
  FOR relation_position IN 1..array_length(relation_names, 1) LOOP
    relation_name := relation_names[relation_position];
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I',
      relation_name,
      application_role
    );
    identity_sequence := pg_get_serial_sequence(
      relation_name,
      identity_columns[relation_position]
    );
    EXECUTE format(
      'REVOKE ALL ON SEQUENCE %s FROM PUBLIC',
      identity_sequence
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO %I',
      identity_sequence,
      application_role
    );
  END LOOP;
END
$application_grants$;

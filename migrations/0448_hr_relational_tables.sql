SET lock_timeout = '5s';

-- Seven HR tables exist in the Drizzle schema, are exported from the runtime
-- barrel, are read and written by live services (document-tag-compat,
-- termination-relational-compat, the sensitive-record sync and the export-job
-- worker) and have unit specs — but were never created, so every one of those
-- paths died 42P01. These are the relational replacements for JSONB arrays, so
-- each carries its tenant-leading composite key, its ordering uniqueness and a
-- composite tenant FK back to the parent row.

CREATE TABLE IF NOT EXISTS hr_document_tags (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  document_tag_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  document_id integer NOT NULL,
  tag text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_hr_document_tags PRIMARY KEY (organization_id, document_tag_id),
  CONSTRAINT uniq_hr_document_tags_parent_tag UNIQUE (organization_id, document_id, tag),
  CONSTRAINT uniq_hr_document_tags_parent_order UNIQUE (organization_id, document_id, sort_order),
  CONSTRAINT fk_hr_document_tags_parent FOREIGN KEY (organization_id, document_id)
    REFERENCES documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_hr_document_tags_value CHECK (btrim(tag) <> '' AND sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_document_tags_parent
  ON hr_document_tags (organization_id, document_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_document_tags_lookup
  ON hr_document_tags (organization_id, tag);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS onboarding_task_dependencies (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  onboarding_task_dependency_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  onboarding_task_id integer NOT NULL,
  prerequisite_task_id integer NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_onboarding_task_dependencies PRIMARY KEY (organization_id, onboarding_task_dependency_id),
  CONSTRAINT uniq_onboarding_task_dependencies_pair UNIQUE (organization_id, onboarding_task_id, prerequisite_task_id),
  CONSTRAINT uniq_onboarding_task_dependencies_order UNIQUE (organization_id, onboarding_task_id, sort_order),
  CONSTRAINT fk_onboarding_task_dependencies_task FOREIGN KEY (organization_id, onboarding_task_id)
    REFERENCES onboarding_tasks (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_onboarding_task_dependencies_prerequisite FOREIGN KEY (organization_id, prerequisite_task_id)
    REFERENCES onboarding_tasks (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT chk_onboarding_task_dependencies_link
    CHECK (onboarding_task_id <> prerequisite_task_id AND sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_task_dependencies_task
  ON onboarding_task_dependencies (organization_id, onboarding_task_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_task_dependencies_prerequisite
  ON onboarding_task_dependencies (organization_id, prerequisite_task_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS termination_reasons (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  termination_reason_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  termination_id integer NOT NULL,
  reason text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_termination_reasons PRIMARY KEY (organization_id, termination_reason_id),
  CONSTRAINT uniq_termination_reasons_parent_reason UNIQUE (organization_id, termination_id, reason),
  CONSTRAINT uniq_termination_reasons_parent_order UNIQUE (organization_id, termination_id, sort_order),
  CONSTRAINT fk_termination_reasons_parent FOREIGN KEY (organization_id, termination_id)
    REFERENCES terminations (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_termination_reasons_value CHECK (btrim(reason) <> '' AND sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_termination_reasons_parent
  ON termination_reasons (organization_id, termination_id, sort_order);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS termination_supporting_documents (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  termination_supporting_document_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  termination_id integer NOT NULL,
  legacy_url text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_termination_supporting_documents PRIMARY KEY (organization_id, termination_supporting_document_id),
  CONSTRAINT uniq_termination_supporting_documents_url UNIQUE (organization_id, termination_id, legacy_url),
  CONSTRAINT uniq_termination_supporting_documents_order UNIQUE (organization_id, termination_id, sort_order),
  CONSTRAINT fk_termination_supporting_documents_parent FOREIGN KEY (organization_id, termination_id)
    REFERENCES terminations (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_termination_supporting_documents_value CHECK (btrim(legacy_url) <> '' AND sort_order >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_termination_supporting_documents_parent
  ON termination_supporting_documents (organization_id, termination_id, sort_order);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS hr_employee_sensitive_disciplinary_records (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  disciplinary_record_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sensitive_fields_id integer NOT NULL,
  source_ordinal integer NOT NULL,
  record_payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_hr_sensitive_disciplinary_records PRIMARY KEY (organization_id, disciplinary_record_id),
  CONSTRAINT uniq_hr_sensitive_disciplinary_parent_order UNIQUE (organization_id, sensitive_fields_id, source_ordinal),
  CONSTRAINT fk_hr_sensitive_disciplinary_parent FOREIGN KEY (organization_id, sensitive_fields_id)
    REFERENCES hr_employee_sensitive_fields (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_hr_sensitive_disciplinary_payload
    CHECK (source_ordinal >= 0 AND jsonb_typeof(record_payload) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sensitive_disciplinary_parent
  ON hr_employee_sensitive_disciplinary_records (organization_id, sensitive_fields_id, source_ordinal);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS hr_employee_sensitive_grievance_records (
  organization_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  grievance_record_id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  sensitive_fields_id integer NOT NULL,
  source_ordinal integer NOT NULL,
  record_payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_hr_sensitive_grievance_records PRIMARY KEY (organization_id, grievance_record_id),
  CONSTRAINT uniq_hr_sensitive_grievance_parent_order UNIQUE (organization_id, sensitive_fields_id, source_ordinal),
  CONSTRAINT fk_hr_sensitive_grievance_parent FOREIGN KEY (organization_id, sensitive_fields_id)
    REFERENCES hr_employee_sensitive_fields (org_id, id) ON DELETE CASCADE,
  CONSTRAINT chk_hr_sensitive_grievance_payload
    CHECK (source_ordinal >= 0 AND jsonb_typeof(record_payload) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sensitive_grievance_parent
  ON hr_employee_sensitive_grievance_records (organization_id, sensitive_fields_id, source_ordinal);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS hr_export_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  entity text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  filters jsonb NOT NULL,
  requested_scope text NOT NULL,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  file_key text,
  file_name text,
  mime_type text DEFAULT 'text/csv' NOT NULL,
  file_size_bytes bigint,
  processed_rows integer DEFAULT 0 NOT NULL,
  row_count integer,
  attempt integer DEFAULT 0 NOT NULL,
  max_attempts integer DEFAULT 3 NOT NULL,
  error_code text,
  error_message text,
  locked_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT uniq_hr_export_jobs_org_id UNIQUE (org_id, id),
  CONSTRAINT chk_hr_export_jobs_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
  CONSTRAINT chk_hr_export_jobs_scope CHECK (requested_scope IN ('all', 'team', 'own', 'none')),
  CONSTRAINT chk_hr_export_jobs_entity CHECK (entity = 'employees'),
  CONSTRAINT chk_hr_export_jobs_attempts CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT chk_hr_export_jobs_counts CHECK (processed_rows >= 0 AND (row_count IS NULL OR row_count >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hr_export_jobs_org_idempotency
  ON hr_export_jobs (org_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_export_jobs_org_status_created
  ON hr_export_jobs (org_id, status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_export_jobs_org_requester_created
  ON hr_export_jobs (org_id, requested_by, created_at);

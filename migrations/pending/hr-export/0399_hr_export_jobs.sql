SET statement_timeout = '5min';
SET lock_timeout = '5s';
SET search_path = public, pg_catalog;

CREATE TABLE hr_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  entity text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_scope text NOT NULL,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  file_key text,
  file_name text,
  mime_type text NOT NULL DEFAULT 'text/csv',
  file_size_bytes bigint,
  processed_rows integer NOT NULL DEFAULT 0,
  row_count integer,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error_code text,
  error_message text,
  locked_at timestamp with time zone,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT hr_export_jobs_org_id_organizations_id_fk
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT uniq_hr_export_jobs_org_id UNIQUE (org_id, id),
  CONSTRAINT chk_hr_export_jobs_status
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
  CONSTRAINT chk_hr_export_jobs_scope
    CHECK (requested_scope IN ('all', 'team', 'own', 'none')),
  CONSTRAINT chk_hr_export_jobs_entity CHECK (entity = 'employees'),
  CONSTRAINT chk_hr_export_jobs_attempts
    CHECK (attempt >= 0 AND max_attempts BETWEEN 1 AND 10),
  CONSTRAINT chk_hr_export_jobs_counts
    CHECK (processed_rows >= 0 AND (row_count IS NULL OR row_count >= 0))
);

CREATE UNIQUE INDEX uniq_hr_export_jobs_org_idempotency
  ON hr_export_jobs (org_id, idempotency_key);

CREATE INDEX idx_hr_export_jobs_org_status_created
  ON hr_export_jobs (org_id, status, created_at);

CREATE INDEX idx_hr_export_jobs_org_requester_created
  ON hr_export_jobs (org_id, requested_by, created_at);

ALTER TABLE hr_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_export_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON hr_export_jobs
  FOR ALL
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

REVOKE ALL ON TABLE hr_export_jobs FROM PUBLIC;

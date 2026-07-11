DO $$ BEGIN
  CREATE TYPE hr_import_entity AS ENUM ('employees','leave_balances','attendance','assets','document_metadata');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_import_status AS ENUM ('validating','previewed','committing','committed','rolled_back','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE hr_import_row_status AS ENUM ('valid','error','committed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS hr_import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity hr_import_entity NOT NULL,
  file_name TEXT NOT NULL,
  status hr_import_status NOT NULL DEFAULT 'validating',
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  error_rows INTEGER NOT NULL DEFAULT 0,
  errors JSONB,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  committed_at TIMESTAMP,
  rolled_back_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_import_jobs_org ON hr_import_jobs(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hr_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES hr_import_jobs(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  payload JSONB NOT NULL,
  status hr_import_row_status NOT NULL DEFAULT 'valid',
  error TEXT,
  created_record_ref JSONB
);

CREATE INDEX IF NOT EXISTS idx_hr_import_rows_job_status ON hr_import_rows(job_id, status);

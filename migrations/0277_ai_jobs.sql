CREATE TYPE ai_job_status AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED');

CREATE TABLE IF NOT EXISTS ai_jobs (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  type varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  status ai_job_status NOT NULL DEFAULT 'QUEUED',
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  idempotency_key varchar(120),
  run_at timestamp NOT NULL DEFAULT now(),
  locked_by varchar(64),
  locked_at timestamp,
  last_error text,
  result jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_jobs_org_idem_key
  ON ai_jobs (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_jobs_status_run_at_priority
  ON ai_jobs (status, run_at, priority);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_org_created_at
  ON ai_jobs (org_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_org_type_status
  ON ai_jobs (org_id, type, status);

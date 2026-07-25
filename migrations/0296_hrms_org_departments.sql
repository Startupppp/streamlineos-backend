ALTER TABLE users ADD COLUMN IF NOT EXISTS org_department_id text REFERENCES org_departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_org_department ON users (org_department_id);

ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS org_department_id text REFERENCES org_departments(id) ON DELETE SET NULL;

ALTER TABLE headcount_requests ADD COLUMN IF NOT EXISTS org_department_id text REFERENCES org_departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_headcount_requests_org_dept ON headcount_requests (org_department_id);

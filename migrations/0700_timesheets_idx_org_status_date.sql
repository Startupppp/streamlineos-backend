SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_timesheets_org_status_date
  ON timesheets (org_id, status, date DESC);

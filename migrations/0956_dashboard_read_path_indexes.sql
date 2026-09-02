-- Dashboard read-path: leave_requests org/approved/dates partial index.
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_approved_dates
  ON leave_requests (org_id, start_date, end_date)
  WHERE status = 'APPROVED';

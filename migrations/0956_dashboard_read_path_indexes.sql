-- Dashboard read-path index: leave_requests(org_id, start_date, end_date) partial on APPROVED, because idx_leave_requests_dates cannot lead under RLS and idx_leave_requests_org_status leaves the date range unnarrowed.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_approved_dates
  ON leave_requests (org_id, start_date, end_date)
  WHERE status = 'APPROVED';

-- 0956_dashboard_read_path_indexes DOWN — drops the dashboard read-path index.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_leave_requests_org_approved_dates;

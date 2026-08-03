-- HRMS performance: composite indexes for real query filters/orderBy patterns.
-- CONCURRENTLY removed: a cold/fresh build has no live traffic to protect, and CONCURRENTLY
-- cannot execute inside a drizzle-kit transaction. Each statement gets its own breakpoint so
-- drizzle-kit wraps it in its own transaction. IF NOT EXISTS keeps re-runs safe.

CREATE INDEX IF NOT EXISTS idx_users_reporting_to
  ON users (reporting_to);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_department
  ON users (department_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_created
  ON leave_requests (org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_requests_org_approver
  ON leave_requests (org_id, approver_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidates_org_status
  ON candidates (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidates_org_created
  ON candidates (org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_job_postings_org_status
  ON job_postings (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_interviews_org_scheduled
  ON interviews (org_id, scheduled_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_offers_org_status
  ON candidate_offers (org_id, offer_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_overtime_org_created
  ON overtime_requests (org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rich_documents_org_updated
  ON rich_documents (org_id, updated_at);

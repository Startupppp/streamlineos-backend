-- HRMS performance: composite indexes matching real query filters/orderBy patterns.
-- Additive and reversible: creates indexes only, touches nothing existing.
-- CONCURRENTLY: run statements outside a transaction (psql autocommit / drizzle push).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_reporting_to
  ON users (reporting_to);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_department
  ON users (department_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leave_requests_org_created
  ON leave_requests (org_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leave_requests_org_approver
  ON leave_requests (org_id, approver_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_candidates_org_status
  ON candidates (org_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_candidates_org_created
  ON candidates (org_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_postings_org_status
  ON job_postings (org_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_interviews_org_scheduled
  ON interviews (org_id, scheduled_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_candidate_offers_org_status
  ON candidate_offers (org_id, offer_status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_overtime_org_created
  ON overtime_requests (org_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rich_documents_org_updated
  ON rich_documents (org_id, updated_at);

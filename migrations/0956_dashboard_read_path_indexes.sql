-- Dashboard read-path indexes.
-- Both queries fell back to a sequential scan at every size tested, and the
-- planner was right to: no existing index could satisfy the ordering or the
-- date range, so the index path cost more than seq scan + sort.

-- announcements: ORDER BY is_pinned DESC, created_at DESC LIMIT 20.
-- idx_announcements_org_pinned is (org_id, is_pinned) with no created_at, so a
-- full sort over every org row was still required after the index scan. Adding
-- the sort column lets the planner walk the index in order and stop at 20.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_announcements_org_pinned_created
  ON announcements (org_id, is_pinned DESC, created_at DESC)
  WHERE status <> 'DRAFT';

-- leave_requests: org_id = $1 AND status = 'APPROVED' AND start_date <= $2 AND end_date >= $2.
-- idx_leave_requests_dates is (start_date, end_date) with no org_id, which under
-- RLS cannot lead; idx_leave_requests_org_status stops at status and leaves the
-- date range unnarrowed. Partial on the status the query actually filters, so the
-- index holds only rows the dashboard reads.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leave_requests_org_approved_dates
  ON leave_requests (org_id, start_date, end_date)
  WHERE status = 'APPROVED';

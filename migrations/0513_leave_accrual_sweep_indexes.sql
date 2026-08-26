-- 0513 — leave accrual sweep: targeted indexes for set-based dedup and balance reads (c14-01/c14-03)
-- =============================================================================
-- Context: the monthly leave accrual sweep (CronLeaveService.accrueMonthlyLeaves)
-- runs two queries that grow with tenant data and are run once per organisation:
--
--   1. hr_leave_ledger accrual dedup check
--      SELECT user_id, leave_type_id
--      FROM hr_leave_ledger
--      WHERE org_id = $1
--        AND leave_type_id = ANY($2)
--        AND txn_type = 'accrual'
--        AND period = $3
--        AND source = 'cron'
--
--      Existing indexes cover (org_id, user_id) and (org_id, user_id, leave_type_id,
--      effective_date) but neither filters on txn_type or period. For a mature org,
--      the ledger accumulates every month's accrual history, so scanning by org_id
--      alone drifts to a full-org scan. A (org_id, txn_type, period, source) index
--      makes this a point lookup: typically a few rows for a single month.
--
--   2. leave_balances balance lookup
--      SELECT user_id, leave_type_id, balance
--      FROM leave_balances
--      WHERE org_id = $1
--        AND leave_type_id = ANY($2)
--        AND year = $3
--
--      The existing idx_leave_balances_org_year covers (org_id, year) but does not
--      include leave_type_id. A composite (org_id, year, leave_type_id) index
--      narrows the scan before the ANY-array filter is applied, and including user_id
--      allows the planner to project the needed columns without a heap fetch if RLS
--      admits an index-only scan (requires org_id first and VACUUM ANALYZE to populate
--      the visibility map).
--
-- RLS NOTE: hr_leave_ledger and leave_balances both carry RLS policies. The planner
-- sets the org_id qual from app.current_org_id() — not leakproof, so the qual runs
-- after the index qual during an index scan. Leading with org_id in both indexes
-- constrains the scan before the RLS qual fires, keeping access paths efficient.
-- LEAKPROOF cannot be granted on Neon (no true superuser); see backend CLAUDE.md §3.
--
-- CONCURRENTLY: CREATE INDEX CONCURRENTLY cannot run inside a migration transaction.
-- Use the plain form here (acceptable for non-partitioned tables at this scale).
-- To build without locking in production: run the CONCURRENTLY form manually first,
-- then apply the migration — Drizzle's IF NOT EXISTS makes it a no-op. Precedent: 0374.
-- =============================================================================

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_accrual_period
  ON hr_leave_ledger (org_id, txn_type, period, source);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_leave_balances_org_year_type
  ON leave_balances (org_id, year, leave_type_id, user_id);

SET lock_timeout = '5s';

-- 1068 — fix PRD-C142: hr_leave_ledger accrual dedup index for the skewed mid tenant
--
-- Problem: the read-cost gate `hr/leave-accrual-ledger-dedup` was measuring 376 blocks
-- on the mid tenant (aaaaaaaa-…0003) against a ceiling of 100, while the large tenant
-- (aaaaaaaa-…0001) measured only 23.  The mid tenant holds 459 rows in hr_leave_ledger
-- all with the same leave_type_id=2; the planner wrongly judged `leave_type_id = ANY('{2}')`
-- as highly selective and chose idx_hr_leave_ledger_user_type_date
-- (org_id, user_id, leave_type_id, effective_date), scanning all 459 rows and then
-- removing 399 via post-fetch filter (period, txn_type, source).  The large tenant
-- uses idx_hr_leave_ledger_accrual_period (org_id, txn_type, period, source) because
-- its statistics are less skewed, but that index still leaves leave_type_id in the
-- post-filter step.
--
-- Fix: add a covering index on (org_id, leave_type_id, txn_type, source, period) so
-- that every WHERE clause predicate of the dedup query is satisfied directly at the
-- index level.  The planner can now descend to exactly (org_id, leave_type_id,
-- txn_type='accrual', source='cron', period='2026-09') without reading any unneeded
-- rows, regardless of tenant data distribution.
--
-- Verified on scratch_local:
--   mid before:  378 buffers (idx_hr_leave_ledger_user_type_date; 399 rows filtered)
--   mid after:     5 buffers (idx_hr_leave_ledger_dedup_lookup; 0 rows filtered)
--   large after:  18 buffers (idx_hr_leave_ledger_dedup_lookup; 0 rows filtered, was 28)
--   small after:   4 buffers (idx_hr_leave_ledger_accrual_period unchanged)
--   tiny after:    5 buffers (idx_hr_leave_ledger_accrual_period unchanged)
--
-- RLS: hr_leave_ledger carries an RLS policy; org_id leads the index so the planner
-- can satisfy the tenant qual at index level before any heap fetch.
-- See backend/CLAUDE.md §7: covering index on an RLS table must contain org_id.
--
-- CONCURRENTLY: plain form used here (acceptable at this table size); to build without
-- a lock in production, run CREATE INDEX CONCURRENTLY … first — the IF NOT EXISTS
-- makes this migration a no-op.  Precedent: 0513.

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_dedup_lookup
  ON hr_leave_ledger (org_id, leave_type_id, txn_type, source, period);

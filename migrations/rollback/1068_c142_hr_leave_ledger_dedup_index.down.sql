-- 1068 DOWN — drops the hr_leave_ledger dedup lookup index.
--
-- @reopens-a-defect: the accrual-ledger-dedup read-cost gate returns to ~376 buffers
-- on the skewed mid tenant (aaaaaaaa-…0003) because the planner reverts to
-- idx_hr_leave_ledger_user_type_date and scans all rows before removing those that
-- don't match (period, txn_type, source) via post-fetch filter.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_hr_leave_ledger_dedup_lookup";

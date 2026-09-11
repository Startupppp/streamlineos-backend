-- Removes the payroll_tds_ytd_ledger immutability guard, restoring the state
-- 1001 left: a paid run's withheld tax rewritable by any direct write. Provided
-- so the chain is reversible, not because reverting is advisable.
--
-- payroll_run_is_paid_out() is dropped with the trigger because 1030 is the only
-- migration that creates or uses it. payroll_org_still_present() is NOT dropped:
-- it belongs to 1001 and five other guards still call it.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_guard_paid_payroll_tds_ytd_row ON payroll_tds_ytd_ledger;
--> statement-breakpoint

DROP FUNCTION IF EXISTS guard_paid_payroll_tds_ytd_row();
--> statement-breakpoint

DROP FUNCTION IF EXISTS payroll_run_is_paid_out(integer);

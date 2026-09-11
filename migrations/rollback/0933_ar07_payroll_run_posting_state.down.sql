-- 0933_ar07_payroll_run_posting_state DOWN — drops the posting-state column and its index; the migration is pending everywhere, so no committed posting state is lost.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_payroll_runs_org_posting_state";
--> statement-breakpoint
ALTER TABLE payroll_runs DROP COLUMN IF EXISTS "posting_state";

-- 1026 DOWN -- drops the composite run foreign key and its supporting index, restoring the
-- state where `payroll_tds_ytd_ledger.run_id` names a payroll run with nothing enforcing it.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE payroll_tds_ytd_ledger DROP CONSTRAINT IF EXISTS fk_payroll_tds_ytd_ledger_run_id_org;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_tds_ytd_ledger_org_run;

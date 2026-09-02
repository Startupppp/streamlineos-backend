-- Reverses 1002. Recreates the two narrower indexes before dropping the wider
-- ones, so no read path is unindexed at any point during the rollback.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_run_employees_org_run
  ON payroll_run_employees (org_id, run_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_payroll_runs_org_entity
  ON payroll_runs (org_id, entity_id);
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payslip_publications_org_user_status;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_runs_org_entity_month;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_payroll_run_employees_org_run_status;

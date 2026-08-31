-- Widen status check constraints on both export job tables to include the "cancelled" terminal state.
-- A cancelled job is never retried (fail/reclaim both gate on status='running') and is set lockedAt=null on transition.
SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "finance_report_export_jobs" DROP CONSTRAINT "chk_fin_report_export_jobs_status";
--> statement-breakpoint
ALTER TABLE "finance_report_export_jobs" ADD CONSTRAINT "chk_fin_report_export_jobs_status" CHECK (status IN ('pending','running','completed','failed','expired','cancelled'));
--> statement-breakpoint
ALTER TABLE "payroll_run_export_jobs" DROP CONSTRAINT "chk_payroll_run_export_jobs_status";
--> statement-breakpoint
ALTER TABLE "payroll_run_export_jobs" ADD CONSTRAINT "chk_payroll_run_export_jobs_status" CHECK (status IN ('pending','running','completed','failed','expired','cancelled'));
--> statement-breakpoint

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('finance_report_export_jobs', 'chk_fin_report_export_jobs_status'),
      ('payroll_run_export_jobs', 'chk_payroll_run_export_jobs_status')
    ) AS v(tbl, con)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      WHERE r.relname = t.tbl AND c.conname = t.con AND c.contype = 'c' AND c.convalidated
    ) THEN
      RAISE EXCEPTION '0826: % is missing a validated CHECK constraint %', t.tbl, t.con;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      WHERE r.relname = t.tbl AND c.conname = t.con
        AND pg_get_constraintdef(c.oid) LIKE '%cancelled%'
    ) THEN
      RAISE EXCEPTION '0826: % CHECK % does not admit the cancelled state', t.tbl, t.con;
    END IF;
  END LOOP;
END $$;

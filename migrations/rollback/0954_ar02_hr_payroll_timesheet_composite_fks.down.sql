-- 0954_ar02_hr_payroll_timesheet_composite_fks DOWN — drops every constraint and index the up migration added.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE timesheet_rates DROP CONSTRAINT IF EXISTS "fk_timesheet_rates_org_task";
--> statement-breakpoint
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS "fk_timesheet_exceptions_org_period";
--> statement-breakpoint
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS "fk_timesheet_exceptions_org_entry";
--> statement-breakpoint
ALTER TABLE payroll_run_employees DROP CONSTRAINT IF EXISTS "fk_payroll_run_employees_org_run";
--> statement-breakpoint
ALTER TABLE payroll_journal_batches DROP CONSTRAINT IF EXISTS "fk_payroll_journal_batches_org_reversal_of";

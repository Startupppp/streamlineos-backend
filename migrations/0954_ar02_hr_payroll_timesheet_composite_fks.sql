-- AR-02: composite tenant FKs — payroll + timesheet cluster
-- Covers: payroll_journal_batches (self-ref), payroll_run_employees,
--         timesheet_exceptions (entry_id, period_id), timesheet_rates (task_id → build.tickets)

SET lock_timeout = DEFAULT;

ALTER TABLE payroll_journal_batches
  ADD CONSTRAINT fk_payroll_journal_batches_org_reversal_of
  FOREIGN KEY (org_id, reversal_of_batch_id)
  REFERENCES payroll_journal_batches (org_id, id)
  ON DELETE SET NULL (reversal_of_batch_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE payroll_journal_batches VALIDATE CONSTRAINT fk_payroll_journal_batches_org_reversal_of;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE payroll_run_employees
  ADD CONSTRAINT fk_payroll_run_employees_org_run
  FOREIGN KEY (org_id, run_id)
  REFERENCES payroll_runs (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE payroll_run_employees VALIDATE CONSTRAINT fk_payroll_run_employees_org_run;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions
  ADD CONSTRAINT fk_timesheet_exceptions_org_entry
  FOREIGN KEY (org_id, entry_id)
  REFERENCES timesheets (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE timesheet_exceptions VALIDATE CONSTRAINT fk_timesheet_exceptions_org_entry;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions
  ADD CONSTRAINT fk_timesheet_exceptions_org_period
  FOREIGN KEY (org_id, period_id)
  REFERENCES timesheet_periods (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE timesheet_exceptions VALIDATE CONSTRAINT fk_timesheet_exceptions_org_period;
SET lock_timeout = DEFAULT;
--> statement-breakpoint
ALTER TABLE timesheet_rates
  ADD CONSTRAINT fk_timesheet_rates_org_task
  FOREIGN KEY (org_id, task_id)
  REFERENCES build.tickets (org_id, id)
  ON DELETE SET NULL (task_id)
  NOT VALID;
--> statement-breakpoint
SET lock_timeout = '5s';
ALTER TABLE timesheet_rates VALIDATE CONSTRAINT fk_timesheet_rates_org_task;
SET lock_timeout = DEFAULT;

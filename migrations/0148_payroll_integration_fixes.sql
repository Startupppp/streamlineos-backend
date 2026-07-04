ALTER TYPE payroll_run_event_type ADD VALUE 'CLOSED';
--> statement-breakpoint
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS closed_by text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE payroll_bank_batches ADD COLUMN IF NOT EXISTS file_key text;
--> statement-breakpoint
DROP TABLE IF EXISTS payroll_custom_templates CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS payroll_lock_events CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS payslip_publish_events CASCADE;

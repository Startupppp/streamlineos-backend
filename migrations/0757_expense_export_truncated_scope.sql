SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE expense_export_jobs
  ADD COLUMN IF NOT EXISTS truncated boolean NOT NULL DEFAULT false;

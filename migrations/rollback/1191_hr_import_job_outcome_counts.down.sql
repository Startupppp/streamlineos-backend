-- Rollback for 1191. Dropping the three counters loses only the per-outcome
-- breakdown of past imports; valid_rows and error_rows are untouched, so a job's
-- history remains readable at the old granularity.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE hr_import_jobs DROP COLUMN IF EXISTS created_rows;
--> statement-breakpoint
ALTER TABLE hr_import_jobs DROP COLUMN IF EXISTS updated_rows;
--> statement-breakpoint
ALTER TABLE hr_import_jobs DROP COLUMN IF EXISTS unchanged_rows;

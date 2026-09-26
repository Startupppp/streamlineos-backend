-- Rollback for 1232_hr_reporting_line_bulk_jobs
-- Roll back 1234 first: hr_reporting_lines.bulk_job_id references the job table.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."hr_reporting_line_bulk_job_rows";
DROP TABLE IF EXISTS "public"."hr_reporting_line_bulk_jobs";

-- Rollback for 1216_hr_reporting_manager_requests
-- Roll back 1217 first: hr_reporting_lines.request_id references this table.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "public"."hr_reporting_manager_requests";

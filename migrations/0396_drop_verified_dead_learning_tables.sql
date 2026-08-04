-- 0396: Remove the seven verified code-dead/empty schema tables.
-- DESTRUCTIVE: rehearse on a recent production clone/branch and take a backup first.
-- This migration intentionally refuses to proceed if any candidate contains data.
-- No CASCADE is used: an unexpected inbound dependency must stop deployment.
-- payroll_statutory_rule_sets is intentionally retained by compliance-data policy.

SET statement_timeout = 0;
SET lock_timeout = '5s';

DO $$
DECLARE
  candidate text;
  row_count bigint;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[
    'service_accounts',
    'allowance_types',
    'course_enrollments',
    'courses',
    'course_categories',
    'training_attendance',
    'training_programs'
  ] LOOP
    IF to_regclass('public.' || candidate) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', candidate) INTO row_count;
      IF row_count <> 0 THEN
        RAISE EXCEPTION 'Refusing to drop %. It contains % row(s).', candidate, row_count;
      END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS service_accounts RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS allowance_types RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS course_enrollments RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS courses RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS course_categories RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS training_attendance RESTRICT;
--> statement-breakpoint
DROP TABLE IF EXISTS training_programs RESTRICT;
--> statement-breakpoint

-- Preflight measured zero, but keep cleanup inside the same atomic migration in case
-- a stale environment still carries catalog grants for the removed feature.
DELETE FROM role_permission_grants WHERE permission_key LIKE 'hr:learning:%';


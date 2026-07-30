SET statement_timeout = 0;

DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_transfers',
    'hr_employee_certifications',
    'hr_employee_education',
    'hr_employee_profiles',
    'hr_hiring_plan_items',
    'hr_policy_assignments',
    'pm_project_grants',
    'pm_workspace_grants'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'Table % has % row(s); refusing to drop.', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "bank_transfers" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "hr_employee_certifications" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "hr_employee_education" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "hr_employee_profiles" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "hr_hiring_plan_items" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "hr_policy_assignments" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "pm_project_grants" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "pm_workspace_grants" CASCADE;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_automations') IS NULL THEN
    RAISE EXCEPTION '1310 precondition: build.project_automations is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_run_at'
  ) THEN
    RAISE EXCEPTION '1310 precondition: last_run_at already exists on build.project_automations — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_automations"
  ADD COLUMN IF NOT EXISTS "last_run_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "build"."project_automations"
  ADD COLUMN IF NOT EXISTS "last_failure_at" timestamptz;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_run_at'
  ), '1310 post-check: last_run_at column was not created on build.project_automations';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_run_at'
  ) = 'YES', '1310 post-check: last_run_at must be nullable — NULL means automation has never run';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_failure_at'
  ), '1310 post-check: last_failure_at column was not created on build.project_automations';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_automations'
      AND column_name = 'last_failure_at'
  ) = 'YES', '1310 post-check: last_failure_at must be nullable — NULL means automation has never failed';
END $$;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_teams') IS NULL THEN
    RAISE EXCEPTION '1315 precondition: build.project_teams is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_teams'
      AND column_name = 'capacity'
  ) THEN
    RAISE EXCEPTION '1315 precondition: capacity already exists on build.project_teams — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_teams"
  ADD COLUMN IF NOT EXISTS "capacity" integer;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_teams'
      AND column_name = 'capacity'
  ), '1315 post-check: capacity column was not created on build.project_teams';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_teams'
      AND column_name = 'capacity'
  ) = 'YES', '1315 post-check: capacity must be nullable — NULL means no capacity limit configured';
END $$;

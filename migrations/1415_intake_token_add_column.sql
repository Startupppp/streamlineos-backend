SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1415 precondition: build.projects is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects" ADD COLUMN IF NOT EXISTS "intake_token" text;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ), '1415 post-check: intake_token column was not added to build.projects';
END $$;

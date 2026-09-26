SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1300 precondition: build.projects is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'intake_published_at'
  ) THEN
    RAISE EXCEPTION '1300 precondition: intake_published_at already exists on build.projects — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD COLUMN IF NOT EXISTS "intake_published_at" timestamptz;
--> statement-breakpoint

UPDATE "build"."projects"
  SET "intake_published_at" = now()
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'intake_published_at'
  ), '1300 post-check: intake_published_at column was not created on build.projects';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'intake_published_at'
  ) = 'YES', '1300 post-check: intake_published_at must be nullable — NULL means intake not published';
END $$;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.projects') IS NULL THEN
    RAISE EXCEPTION '1335 precondition: build.projects is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'portal_published_at'
  ) THEN
    RAISE EXCEPTION '1335 precondition: portal_published_at already exists on build.projects — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD COLUMN IF NOT EXISTS "portal_published_at" timestamptz;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'portal_published_at'
  ), '1335 post-check: portal_published_at column was not created on build.projects';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'portal_published_at'
  ) = 'YES', '1335 post-check: portal_published_at must be nullable — NULL means portal not yet published';
END $$;

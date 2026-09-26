SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_updates') IS NULL THEN
    RAISE EXCEPTION '1305 precondition: build.project_updates is absent — this is not a Build database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'wins'
  ) THEN
    RAISE EXCEPTION '1305 precondition: wins already exists on build.project_updates — migration has already run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "wins" text;
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "risks" text;
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "next" text;
--> statement-breakpoint

ALTER TABLE "build"."project_updates"
  ADD COLUMN IF NOT EXISTS "citations" text;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'wins'
  ), '1305 post-check: wins column was not created on build.project_updates';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'risks'
  ), '1305 post-check: risks column was not created on build.project_updates';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'next'
  ), '1305 post-check: next column was not created on build.project_updates';
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'citations'
  ), '1305 post-check: citations column was not created on build.project_updates';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'project_updates'
      AND column_name = 'wins'
  ) = 'YES', '1305 post-check: wins must be nullable — NULL means the author did not provide this section';
END $$;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'portal_published_at'
  ) THEN
    RAISE EXCEPTION '1335 rollback precondition: portal_published_at does not exist on build.projects — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP COLUMN IF EXISTS "portal_published_at";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build'
      AND table_name = 'projects'
      AND column_name = 'portal_published_at'
  ), '1335 rollback post-check: portal_published_at column was not dropped from build.projects';
END $$;

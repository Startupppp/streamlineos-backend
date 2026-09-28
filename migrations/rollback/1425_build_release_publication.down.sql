SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'published_at'
  ) THEN
    RAISE EXCEPTION '1425-rollback precondition: build.project_releases.published_at does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_releases_org_published;
--> statement-breakpoint

ALTER TABLE "build"."project_releases" DROP COLUMN IF EXISTS "published_at";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'published_at'
  ), '1425-rollback post-check: published_at survived the rollback';
END $$;

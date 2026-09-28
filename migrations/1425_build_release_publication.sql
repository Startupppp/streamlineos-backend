SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_releases') IS NULL THEN
    RAISE EXCEPTION '1425 precondition: build.project_releases is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION '1425 precondition: build.project_releases.status is absent, so there would be no release transition for published_at to record';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."project_releases" ADD COLUMN IF NOT EXISTS "published_at" timestamptz;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_releases_org_published
  ON build.project_releases (org_id, published_at)
  WHERE deleted_at IS NULL AND published_at IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'published_at'
  ), '1425 post-check: published_at was not added to build.project_releases';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'published_at'
  ) = 'YES', '1425 post-check: published_at must stay nullable — a draft release has not been published, and that is the majority state';

  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."project_releases" WHERE "published_at" IS NOT NULL
  ), '1425 post-check: published_at was backfilled. Releases already at status released were published at a time nobody recorded, and copying updated_at in would date every historical publication to whenever that row was last edited. An already-released release with a null published_at is the truthful state and the reader must render it as unknown rather than absent';

  ASSERT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_project_releases_org_published'
  ), '1425 post-check: idx_project_releases_org_published is missing, so ordering or filtering releases by publication date would sequentially scan the tenant';
END $$;

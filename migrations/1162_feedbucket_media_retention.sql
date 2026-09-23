SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.feedbucket_submissions') IS NULL THEN
    RAISE EXCEPTION '1162 precondition: build.feedbucket_submissions is absent — this is not a Feedbucket database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'feedbucket_submissions'
       AND column_name = 'media_purged_at'
  ) THEN
    RAISE EXCEPTION '1162 precondition: build.feedbucket_submissions.media_purged_at already exists — this migration has run';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."feedbucket_submissions"
  ADD COLUMN IF NOT EXISTS "media_purged_at" timestamp;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedbucket_submissions_media_purge_due"
  ON "build"."feedbucket_submissions" ("deleted_at")
  WHERE "deleted_at" IS NOT NULL AND "media_purged_at" IS NULL;

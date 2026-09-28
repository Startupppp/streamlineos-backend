SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION '1421-rollback precondition: build.project_webhooks.version does not exist — nothing to roll back';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION '1421-rollback precondition: build.okr_goals.version does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_okr_goals_version_bump ON "build"."okr_goals";
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_project_webhooks_version_bump ON "build"."project_webhooks";
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" DROP CONSTRAINT IF EXISTS "chk_okr_goals_confidence_range";
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint

ALTER TABLE "build"."okr_goals" DROP COLUMN IF EXISTS "confidence";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" DROP COLUMN IF EXISTS "updated_at";
--> statement-breakpoint

ALTER TABLE "build"."project_webhooks" DROP COLUMN IF EXISTS "secret_set_at";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_webhooks'
      AND column_name IN ('secret_set_at', 'updated_at', 'version')
  ), '1421-rollback post-check: a project_webhooks column added by 1421 still exists';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals'
      AND column_name IN ('confidence', 'version')
  ), '1421-rollback post-check: an okr_goals column added by 1421 still exists';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'okr_goals' AND column_name = 'updated_at'
  ), '1421-rollback post-check: okr_goals.updated_at was dropped, but 1421 never created it';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname IN ('trg_project_webhooks_version_bump', 'trg_okr_goals_version_bump')
  ), '1421-rollback post-check: a version-bump trigger added by 1421 still exists';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'build' AND p.proname = 'bump_sibling_version'
  ), '1421-rollback post-check: build.bump_sibling_version() was dropped, but it belongs to 1395 and four other tables still use it';
END $$;

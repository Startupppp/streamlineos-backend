SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'build.okr_links'::regclass
      AND conname = 'chk_okr_links_exclusive_arc'
  ) THEN
    RAISE EXCEPTION '1372-rollback precondition: chk_okr_links_exclusive_arc does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build.okr_links
  DROP CONSTRAINT IF EXISTS chk_okr_links_exclusive_arc;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_okr_links_goal_project;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'build.okr_links'::regclass
      AND conname = 'chk_okr_links_exclusive_arc'
  ), '1372-rollback post-check: chk_okr_links_exclusive_arc was not dropped';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'okr_links'
      AND indexname = 'uniq_okr_links_goal_project'
  ), '1372-rollback post-check: uniq_okr_links_goal_project was not dropped';
END $$;

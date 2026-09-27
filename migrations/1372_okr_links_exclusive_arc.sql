SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.okr_links') IS NULL THEN
    RAISE EXCEPTION '1372 precondition: build.okr_links is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build.okr_links
  ADD CONSTRAINT chk_okr_links_exclusive_arc
  CHECK (num_nonnulls(ticket_id, project_id) = 1)
  NOT VALID;
--> statement-breakpoint

ALTER TABLE build.okr_links
  VALIDATE CONSTRAINT chk_okr_links_exclusive_arc;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_okr_links_goal_project
  ON build.okr_links (goal_id, project_id)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'build.okr_links'::regclass
      AND conname = 'chk_okr_links_exclusive_arc'
      AND convalidated = TRUE
  ), '1372 post-check: chk_okr_links_exclusive_arc not present or not validated';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'okr_links'
      AND indexname = 'uniq_okr_links_goal_project'
  ), '1372 post-check: uniq_okr_links_goal_project was not created';
END $$;

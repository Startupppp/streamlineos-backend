SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.cycles') IS NULL THEN
    RAISE EXCEPTION '1371 precondition: build.cycles is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_cycles_one_active_per_project
  ON build.cycles (org_id, project_id)
  WHERE status = 'active' AND deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_cycles_no_date_overlap'
  ) THEN
    ALTER TABLE build.cycles
      ADD CONSTRAINT excl_cycles_no_date_overlap
      EXCLUDE USING gist (
        org_id     WITH =,
        project_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
      )
      WHERE (deleted_at IS NULL);
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'cycles'
      AND indexname = 'uniq_cycles_one_active_per_project'
  ), '1371 post-check: uniq_cycles_one_active_per_project was not created';
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_cycles_no_date_overlap'
  ), '1371 post-check: excl_cycles_no_date_overlap was not created';
END $$;

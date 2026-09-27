SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'cycles'
      AND indexname = 'uniq_cycles_one_active_per_project'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_cycles_no_date_overlap'
  ) THEN
    RAISE EXCEPTION '1371-rollback precondition: neither constraint exists — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_cycles_one_active_per_project;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'excl_cycles_no_date_overlap'
  ) THEN
    ALTER TABLE build.cycles DROP CONSTRAINT excl_cycles_no_date_overlap;
  END IF;
END $$;

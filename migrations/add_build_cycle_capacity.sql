SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ) THEN
    ALTER TABLE build.cycles ADD COLUMN capacity integer;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ) = 1, 'build.cycles.capacity must exist after migration';
END $$;

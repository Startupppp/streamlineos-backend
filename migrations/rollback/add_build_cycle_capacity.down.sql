SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ) THEN
    ALTER TABLE build.cycles DROP COLUMN capacity;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ), 'build.cycles.capacity must be absent after rollback';
END $$;

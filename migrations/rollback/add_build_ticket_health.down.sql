SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS build.idx_tickets_org_project_health;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ) THEN
    ALTER TABLE build.tickets DROP COLUMN health;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ), 'build.tickets.health must be absent after rollback';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'tickets' AND indexname = 'idx_tickets_org_project_health'
  ), 'idx_tickets_org_project_health must be absent after rollback';
END $$;

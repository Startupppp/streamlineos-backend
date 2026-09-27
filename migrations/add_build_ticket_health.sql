SET lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ) THEN
    ALTER TABLE build.tickets ADD COLUMN health project_portfolio_health;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_org_project_health
  ON build.tickets (org_id, project_id, health)
  WHERE deleted_at IS NULL AND health IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ) = 1, 'build.tickets.health must exist after migration';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'tickets' AND indexname = 'idx_tickets_org_project_health'
  ), 'idx_tickets_org_project_health must exist after migration';
END $$;

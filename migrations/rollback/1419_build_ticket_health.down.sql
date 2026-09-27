SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ) THEN
    RAISE EXCEPTION '1419-rollback precondition: build.tickets.health does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_tickets_org_project_health";
--> statement-breakpoint

ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "health";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ), '1419-rollback post-check: build.tickets.health still exists';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'tickets' AND indexname = 'idx_tickets_org_project_health'
  ), '1419-rollback post-check: idx_tickets_org_project_health still exists';
END $$;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1419 precondition: build.tickets is absent';
  END IF;
  IF to_regtype('public.project_portfolio_health') IS NULL THEN
    RAISE EXCEPTION '1419 precondition: enum project_portfolio_health is absent — portfolios and programs already store health with it, so it must exist before tickets can reuse it';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."tickets"
  ADD COLUMN IF NOT EXISTS "health" public.project_portfolio_health;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_health"
  ON "build"."tickets" ("org_id", "project_id", "health")
  WHERE deleted_at IS NULL AND health IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ), '1419 post-check: build.tickets.health was not added';

  ASSERT (
    SELECT udt_name FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'health'
  ) = 'project_portfolio_health', '1419 post-check: health is not the shared project_portfolio_health enum, so portfolio and ticket health would disagree';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'tickets' AND indexname = 'idx_tickets_org_project_health'
  ), '1419 post-check: idx_tickets_org_project_health was not created';
END $$;

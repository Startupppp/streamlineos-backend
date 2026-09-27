SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build_events.ticket_activity_log') IS NULL THEN
    RAISE EXCEPTION '1378 precondition: build_events.ticket_activity_log is absent';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1378 precondition: build.tickets is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build_events.ticket_activity_log
  ADD COLUMN IF NOT EXISTS project_id integer;
--> statement-breakpoint

UPDATE build_events.ticket_activity_log tal
SET project_id = t.project_id
FROM build.tickets t
WHERE t.org_id = tal.org_id
  AND t.id = tal.ticket_id
  AND tal.project_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ticket_activity_log_org_project
  ON build_events.ticket_activity_log (org_id, project_id, id)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build_events'
      AND table_name = 'ticket_activity_log'
      AND column_name = 'project_id'
  ), '1378 post-check: project_id column was not added to build_events.ticket_activity_log';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build_events'
      AND tablename = 'ticket_activity_log'
      AND indexname = 'idx_ticket_activity_log_org_project'
  ), '1378 post-check: idx_ticket_activity_log_org_project was not created';
END $$;

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build_events'
      AND table_name = 'ticket_activity_log'
      AND column_name = 'project_id'
  ) THEN
    RAISE EXCEPTION '1378-rollback precondition: build_events.ticket_activity_log.project_id does not exist — cannot roll back';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build_events'
      AND tablename = 'ticket_activity_log'
      AND indexname = 'idx_ticket_activity_log_org_project'
  ) THEN
    RAISE EXCEPTION '1378-rollback precondition: idx_ticket_activity_log_org_project does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX build_events.idx_ticket_activity_log_org_project;
--> statement-breakpoint

ALTER TABLE build_events.ticket_activity_log
  DROP COLUMN project_id;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build_events'
      AND tablename = 'ticket_activity_log'
      AND indexname = 'idx_ticket_activity_log_org_project'
  ), '1378-rollback post-check: idx_ticket_activity_log_org_project still exists after drop';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build_events'
      AND table_name = 'ticket_activity_log'
      AND column_name = 'project_id'
  ), '1378-rollback post-check: project_id column still exists after drop';
END $$;

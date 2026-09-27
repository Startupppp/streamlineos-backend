SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build_events.cycle_scope_events') IS NULL THEN
    RAISE EXCEPTION '1394-rollback precondition: build_events.cycle_scope_events does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'build_events' AND tablename = 'cycle_scope_events'
  ) THEN
    ALTER TABLE build_events.cycle_scope_events RENAME TO sprint_scope_events;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'cycle_scope_event_type' AND n.nspname = 'public'
  ) THEN
    ALTER TYPE public.cycle_scope_event_type RENAME TO sprint_scope_event_type;
  END IF;
END $$;

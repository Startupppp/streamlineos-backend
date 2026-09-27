SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build_events.cycle_scope_events') IS NULL
    AND to_regclass('build_events.sprint_scope_events') IS NULL THEN
    RAISE EXCEPTION '1394 precondition: neither build_events.sprint_scope_events nor build_events.cycle_scope_events exists';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'build_events' AND tablename = 'sprint_scope_events'
  ) THEN
    ALTER TABLE build_events.sprint_scope_events RENAME TO cycle_scope_events;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'sprint_scope_event_type' AND n.nspname = 'public'
  ) THEN
    ALTER TYPE public.sprint_scope_event_type RENAME TO cycle_scope_event_type;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'build_events' AND tablename = 'cycle_scope_events'
  ), '1394 post-check: build_events.cycle_scope_events does not exist';
  ASSERT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'cycle_scope_event_type' AND n.nspname = 'public'
  ), '1394 post-check: public.cycle_scope_event_type does not exist';
END $$;

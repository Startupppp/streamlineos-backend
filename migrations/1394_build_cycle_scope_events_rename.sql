-- 1394 — Build: Rename sprint_scope_events → cycle_scope_events (guarded)
--
-- Promotes backend/migrations/sql/a-sprint-cycle-06-rename-scope-events.sql into
-- the journalled migration chain. Both RENAME statements are wrapped in DO blocks
-- that check for the OLD name before acting, making the migration idempotent:
--
--   • If the rename was already applied (stray file was run manually), both
--     DO blocks are no-ops. The postcondition still asserts the new names exist.
--   • If the rename was never applied, both objects are renamed atomically.
--
-- Precondition note from a-sprint-cycle-06:
--   A build in which src/db/schema/build/cycle-events.ts declares
--   buildEvents.table("cycle_scope_events") must already be deployed before
--   this migration commits; otherwise every burnup request raises
--   'relation "build_events"."sprint_scope_events" does not exist'.
--   That schema file already uses the new name. Apply this migration in the same
--   maintenance step as the code deployment that references cycle_scope_events.
--
-- Ticket 66: https://linear.app/streamlineos/issue/SL-66
--
-- Migration order: no dependency on 1371/1372/1380/1381/1393. Apply after the
-- code deployment that declares build_events.cycle_scope_events.

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

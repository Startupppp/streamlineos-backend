-- 0431: move the Build append-only tables into a `build_events` schema.
--
-- First step of the schema split. These three are the pilot: append-only, largest in the module,
-- and referenced by nothing qualified in code. SET SCHEMA is catalog-only — FKs, indexes and RLS
-- policies follow the table. USAGE and per-schema ALTER DEFAULT PRIVILEGES do NOT follow and are
-- granted here.
--
-- The ALTER ROLE ... SET search_path below is NOT a working bridge on this deployment and must not
-- be relied on: Neon's pooled endpoint does not apply per-role startup settings, so the session
-- search_path stays "$user", public and an unqualified reference to a moved table fails 42P01.
-- Verified after applying. It is kept only because it does take effect on a direct (unpooled)
-- connection. The real contract is that every reference must be QUALIFIED before its table moves —
-- here that is satisfied by declaring all three with pgSchema("build_events") in Drizzle, so the
-- emitted SQL names the schema. Apply the same rule to the larger `build` move.

CREATE SCHEMA IF NOT EXISTS "build_events";
--> statement-breakpoint

GRANT USAGE ON SCHEMA "build_events" TO streamline_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_activity_log', 'ticket_comments', 'sprint_scope_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA build_events', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA "build_events"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO streamline_app;
--> statement-breakpoint

ALTER ROLE streamline_app SET search_path = public, build_events, app;
--> statement-breakpoint

ALTER ROLE neondb_owner SET search_path = "$user", public, build_events, app;

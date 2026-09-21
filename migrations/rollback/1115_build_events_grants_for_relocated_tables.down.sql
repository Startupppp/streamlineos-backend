-- Rollback for 1115_build_events_grants_for_relocated_tables.
--
-- The forward migration granted USAGE on schema build_events, full DML
-- (SELECT, INSERT, UPDATE, DELETE) on all tables, and USAGE/SELECT on all
-- sequences to streamline_app.
--
-- Reversing these grants removes application-level access to every table and
-- sequence in the build_events schema. Any feature that reads or writes those
-- tables will stop functioning until the grants are restored. Revocation order
-- is tables and sequences first, then the schema USAGE, matching dependency
-- order.

SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'build_events') THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "build_events" FROM streamline_app';
    EXECUTE 'REVOKE USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "build_events" FROM streamline_app';
    EXECUTE 'REVOKE USAGE ON SCHEMA "build_events" FROM streamline_app';
  END IF;
END $$;

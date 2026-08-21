-- Rollback for 0431: move the three tables back to public. Catalog-only, no data movement.
-- The schema itself is dropped only if empty, so a table added later is never silently destroyed.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ticket_activity_log', 'ticket_comments', 'sprint_scope_events'] LOOP
    IF to_regclass('build_events.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE build_events.%I SET SCHEMA public', t);
    END IF;
  END LOOP;
END $$;

ALTER ROLE streamline_app SET search_path = public, app;
ALTER ROLE neondb_owner SET search_path = "$user", public, app;
DROP SCHEMA IF EXISTS "build_events" RESTRICT;

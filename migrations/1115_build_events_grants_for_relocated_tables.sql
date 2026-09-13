SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'build_events') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA "build_events" TO streamline_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "build_events" TO streamline_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "build_events" TO streamline_app';
  END IF;
END $$;

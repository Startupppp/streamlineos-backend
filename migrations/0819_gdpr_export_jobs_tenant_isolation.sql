SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  t text;
  targets text[] := ARRAY[
    'gdpr_export_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '0819: table public.% does not exist', t;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', t)::regclass
        AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attnotnull
    ) THEN
      RAISE EXCEPTION '0819: table public.% has no NOT NULL org_id column', t;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = format('public.%I', t)::regclass AND p.polname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I FOR ALL USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())',
        t
      );
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(targets)
      AND (NOT c.relrowsecurity
        OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
  ) THEN
    RAISE EXCEPTION '0819: at least one target still lacks RLS or a policy';
  END IF;
END $$;
--> statement-breakpoint

REVOKE ALL ON TABLE public.calendar_actor_migration_report FROM streamline_app;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name = 'calendar_actor_migration_report'
      AND grantee = 'streamline_app'
  ) THEN
    RAISE EXCEPTION '0819: streamline_app still holds privileges on calendar_actor_migration_report';
  END IF;
END $$;

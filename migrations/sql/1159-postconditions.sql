DO $$
DECLARE
  leftover text;
  n_projects bigint;
  n_products bigint;
  n_teams bigint;
  n_tickets bigint;
  n_roster bigint;
  n_ledger bigint;
BEGIN
  IF to_regclass('build.pm_workspaces') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: build.pm_workspaces still exists';
  END IF;
  IF to_regclass('build.pm_workspace_memberships') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: build.pm_workspace_memberships still exists';
  END IF;
  IF to_regclass('build.project_workspace_members') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: build.project_workspace_members still exists — the rename did not happen';
  END IF;
  IF to_regclass('build.build_members') IS NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: build.build_members does not exist — the Build member roster was lost';
  END IF;

  SELECT string_agg(table_schema || '.' || table_name, ', ')
    INTO leftover
    FROM information_schema.columns
   WHERE column_name = 'pm_workspace_id';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: pm_workspace_id survives on %', leftover;
  END IF;

  SELECT string_agg(conname, ', ') INTO leftover
    FROM pg_constraint WHERE conname ILIKE '%pm_workspace%' OR conname ILIKE '%project_workspace_members%';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: workspace-named constraints survive: %', leftover;
  END IF;

  SELECT string_agg(schemaname || '.' || indexname, ', ') INTO leftover
    FROM pg_indexes WHERE indexname ILIKE '%pm_workspace%' OR indexname ILIKE '%project_workspace_members%';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition FAILED: workspace-named indexes survive: %', leftover;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'build' AND tablename = 'build_members' AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1159 postcondition FAILED: build.build_members has no tenant_isolation RLS policy — the rename dropped it';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'build' AND table_name = 'build_members'
       AND grantee = 'streamline_app' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION '1159 postcondition FAILED: streamline_app cannot SELECT build.build_members — the app will read 42501';
  END IF;

  SELECT count(*) INTO n_ledger FROM drizzle.__drizzle_migrations
   WHERE hash = (SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1);
  IF n_ledger <> 1 THEN
    RAISE EXCEPTION '1159 postcondition FAILED: the newest ledger hash appears % times, not once', n_ledger;
  END IF;

  SELECT count(*) INTO n_projects FROM build.projects;
  SELECT count(*) INTO n_products FROM build.managed_products;
  SELECT count(*) INTO n_teams    FROM build.project_teams;
  SELECT count(*) INTO n_tickets  FROM build.tickets;
  SELECT count(*) INTO n_roster   FROM build.build_members;

  RAISE NOTICE '1159 postcondition PASSED. Compare against the precondition run: projects=% managed_products=% project_teams=% tickets=% build_member_roster=%.',
    n_projects, n_products, n_teams, n_tickets, n_roster;
END
$$;

DO $$
DECLARE
  n_projects bigint;
  n_products bigint;
  n_teams bigint;
  n_tickets bigint;
  n_roster bigint;
  n_workspaces bigint;
  n_ws_members bigint;
BEGIN
  IF to_regclass('build.pm_workspaces') IS NULL THEN
    RAISE EXCEPTION '1159 precondition FAILED: build.pm_workspaces is absent — 1159 has already run or this is not a Build database';
  END IF;
  IF to_regclass('build.pm_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION '1159 precondition FAILED: build.pm_workspace_memberships is absent while build.pm_workspaces exists — the schema is half-removed';
  END IF;
  IF to_regclass('build.project_workspace_members') IS NULL THEN
    RAISE EXCEPTION '1159 precondition FAILED: build.project_workspace_members is absent — the Build member roster 1159 renames does not exist';
  END IF;
  IF to_regclass('build.build_members') IS NOT NULL THEN
    RAISE EXCEPTION '1159 precondition FAILED: build.build_members already exists — the rename target is occupied';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_projects_org_pm_workspace' AND NOT convalidated
  ) THEN
    RAISE EXCEPTION '1159 precondition FAILED: fk_projects_org_pm_workspace is NOT VALID — resolve the pending validation before dropping it';
  END IF;

  SELECT count(*) INTO n_projects    FROM build.projects;
  SELECT count(*) INTO n_products    FROM build.managed_products;
  SELECT count(*) INTO n_teams       FROM build.project_teams;
  SELECT count(*) INTO n_tickets     FROM build.tickets;
  SELECT count(*) INTO n_roster      FROM build.project_workspace_members;
  SELECT count(*) INTO n_workspaces  FROM build.pm_workspaces;
  SELECT count(*) INTO n_ws_members  FROM build.pm_workspace_memberships;

  RAISE NOTICE '1159 precondition PASSED. Record these counts and compare them after the apply: projects=% managed_products=% project_teams=% tickets=% build_member_roster=%. To be deleted: pm_workspaces=% pm_workspace_memberships=%.',
    n_projects, n_products, n_teams, n_tickets, n_roster, n_workspaces, n_ws_members;
END
$$;

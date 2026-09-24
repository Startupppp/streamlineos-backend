SET lock_timeout = '5s';
--> statement-breakpoint

SET statement_timeout = 0;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.pm_workspaces') IS NULL THEN
    RAISE EXCEPTION '1159 precondition: build.pm_workspaces is already absent — this migration has run, or the database is not a Build database';
  END IF;
  IF to_regclass('build.pm_workspace_memberships') IS NULL THEN
    RAISE EXCEPTION '1159 precondition: build.pm_workspace_memberships is absent while build.pm_workspaces exists — the schema is half-removed and must be inspected by hand';
  END IF;
  IF to_regclass('build.project_workspace_members') IS NULL THEN
    RAISE EXCEPTION '1159 precondition: build.project_workspace_members is absent — the Build member roster this migration renames does not exist';
  END IF;
  IF to_regclass('build.build_members') IS NOT NULL THEN
    RAISE EXCEPTION '1159 precondition: build.build_members already exists — the rename target is occupied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'project_workspace_members'
       AND column_name = 'membership_id'
  ) THEN
    RAISE EXCEPTION '1159 precondition: build.project_workspace_members has no membership_id column — the roster is not the shape this migration preserves';
  END IF;
END
$$;
--> statement-breakpoint

CREATE TEMPORARY TABLE _ws_removal_before AS
SELECT
  (SELECT count(*) FROM build.projects)                  AS projects,
  (SELECT count(*) FROM build.managed_products)          AS managed_products,
  (SELECT count(*) FROM build.project_teams)             AS project_teams,
  (SELECT count(*) FROM build.project_team_members)      AS project_team_members,
  (SELECT count(*) FROM build.project_team_assignments)  AS project_team_assignments,
  (SELECT count(*) FROM build.project_members)           AS project_members,
  (SELECT count(*) FROM build.tickets)                   AS tickets,
  (SELECT count(*) FROM build.roadmap_items)             AS roadmap_items,
  (SELECT count(*) FROM public.goals)                    AS goals,
  (SELECT count(*) FROM public.project_client_grants)    AS project_client_grants,
  (SELECT count(*) FROM public.organizations)            AS organizations,
  (SELECT count(*) FROM build.project_workspace_members) AS build_members;
--> statement-breakpoint

ALTER TABLE "build"."projects" DROP CONSTRAINT IF EXISTS "fk_projects_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_projects_org_pm_workspace";
--> statement-breakpoint

ALTER TABLE "build"."projects" DROP COLUMN IF EXISTS "pm_workspace_id";
--> statement-breakpoint

ALTER TABLE "build"."managed_products" DROP CONSTRAINT IF EXISTS "fk_managed_products_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_managed_products_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_managed_products_org_workspace";
--> statement-breakpoint

ALTER TABLE "build"."managed_products" DROP COLUMN IF EXISTS "pm_workspace_id";
--> statement-breakpoint

ALTER TABLE "build"."project_teams" DROP CONSTRAINT IF EXISTS "fk_project_teams_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_project_teams_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_project_teams_org_workspace";
--> statement-breakpoint

ALTER TABLE "build"."project_teams" DROP COLUMN IF EXISTS "pm_workspace_id";
--> statement-breakpoint

ALTER TABLE "public"."project_client_grants" DROP COLUMN IF EXISTS "pm_workspace_id";
--> statement-breakpoint

ALTER TABLE "build"."project_workspace_members" DROP CONSTRAINT IF EXISTS "fk_project_workspace_members_org_pm_workspace";
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_project_workspace_members_org_pm_workspace";
--> statement-breakpoint

ALTER TABLE "build"."project_workspace_members" DROP COLUMN IF EXISTS "pm_workspace_id";
--> statement-breakpoint

ALTER TABLE "build"."project_workspace_members" RENAME TO "build_members";
--> statement-breakpoint

ALTER SEQUENCE "build"."project_workspace_members_id_seq" RENAME TO "build_members_id_seq";
--> statement-breakpoint

ALTER TABLE "build"."build_members" RENAME CONSTRAINT "project_workspace_members_pkey" TO "build_members_pkey";
--> statement-breakpoint

ALTER TABLE "build"."build_members" RENAME CONSTRAINT "uniq_project_workspace_members_org_id" TO "uniq_build_members_org_id";
--> statement-breakpoint

ALTER TABLE "build"."build_members" RENAME CONSTRAINT "fk_project_workspace_members_actor" TO "fk_build_members_actor";
--> statement-breakpoint

ALTER TABLE "build"."build_members" RENAME CONSTRAINT "project_workspace_members_org_id_fkey" TO "fk_build_members_org";
--> statement-breakpoint

ALTER INDEX "build"."uniq_project_workspace_members_org_user" RENAME TO "uniq_build_members_org_membership";
--> statement-breakpoint

DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = to_regclass('build.build_members')
       AND conname LIKE 'project_workspace_members_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "build"."build_members" RENAME CONSTRAINT %I TO %I',
      con.conname,
      'build_members_' || substring(con.conname from length('project_workspace_members_') + 1)
    );
  END LOOP;
END
$$;
--> statement-breakpoint

DROP TABLE "build"."pm_workspace_memberships";
--> statement-breakpoint

DROP TABLE "build"."pm_workspaces";
--> statement-breakpoint

DO $$
DECLARE
  before_row _ws_removal_before%ROWTYPE;
  leftover text;
BEGIN
  SELECT * INTO before_row FROM _ws_removal_before;

  IF to_regclass('build.pm_workspaces') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition: build.pm_workspaces still exists';
  END IF;
  IF to_regclass('build.pm_workspace_memberships') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition: build.pm_workspace_memberships still exists';
  END IF;
  IF to_regclass('build.project_workspace_members') IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition: build.project_workspace_members still exists after the rename';
  END IF;
  IF to_regclass('build.build_members') IS NULL THEN
    RAISE EXCEPTION '1159 postcondition: build.build_members does not exist';
  END IF;

  SELECT string_agg(table_schema || '.' || table_name, ', ')
    INTO leftover
    FROM information_schema.columns
   WHERE column_name = 'pm_workspace_id';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION '1159 postcondition: pm_workspace_id survives on %', leftover;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'build' AND tablename = 'build_members' AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION '1159 postcondition: build.build_members lost its tenant_isolation policy in the rename';
  END IF;

  IF (SELECT count(*) FROM build.projects) <> before_row.projects THEN
    RAISE EXCEPTION '1159 postcondition: build.projects moved from % to %', before_row.projects, (SELECT count(*) FROM build.projects);
  END IF;
  IF (SELECT count(*) FROM build.managed_products) <> before_row.managed_products THEN
    RAISE EXCEPTION '1159 postcondition: build.managed_products moved from % to %', before_row.managed_products, (SELECT count(*) FROM build.managed_products);
  END IF;
  IF (SELECT count(*) FROM build.project_teams) <> before_row.project_teams THEN
    RAISE EXCEPTION '1159 postcondition: build.project_teams moved from % to %', before_row.project_teams, (SELECT count(*) FROM build.project_teams);
  END IF;
  IF (SELECT count(*) FROM build.project_team_members) <> before_row.project_team_members THEN
    RAISE EXCEPTION '1159 postcondition: build.project_team_members moved from % to %', before_row.project_team_members, (SELECT count(*) FROM build.project_team_members);
  END IF;
  IF (SELECT count(*) FROM build.project_team_assignments) <> before_row.project_team_assignments THEN
    RAISE EXCEPTION '1159 postcondition: build.project_team_assignments moved from % to %', before_row.project_team_assignments, (SELECT count(*) FROM build.project_team_assignments);
  END IF;
  IF (SELECT count(*) FROM build.project_members) <> before_row.project_members THEN
    RAISE EXCEPTION '1159 postcondition: build.project_members moved from % to %', before_row.project_members, (SELECT count(*) FROM build.project_members);
  END IF;
  IF (SELECT count(*) FROM build.tickets) <> before_row.tickets THEN
    RAISE EXCEPTION '1159 postcondition: build.tickets moved from % to %', before_row.tickets, (SELECT count(*) FROM build.tickets);
  END IF;
  IF (SELECT count(*) FROM build.roadmap_items) <> before_row.roadmap_items THEN
    RAISE EXCEPTION '1159 postcondition: build.roadmap_items moved from % to %', before_row.roadmap_items, (SELECT count(*) FROM build.roadmap_items);
  END IF;
  IF (SELECT count(*) FROM public.goals) <> before_row.goals THEN
    RAISE EXCEPTION '1159 postcondition: public.goals moved from % to %', before_row.goals, (SELECT count(*) FROM public.goals);
  END IF;
  IF (SELECT count(*) FROM public.project_client_grants) <> before_row.project_client_grants THEN
    RAISE EXCEPTION '1159 postcondition: public.project_client_grants moved from % to %', before_row.project_client_grants, (SELECT count(*) FROM public.project_client_grants);
  END IF;
  IF (SELECT count(*) FROM public.organizations) <> before_row.organizations THEN
    RAISE EXCEPTION '1159 postcondition: public.organizations moved from % to %', before_row.organizations, (SELECT count(*) FROM public.organizations);
  END IF;
  IF (SELECT count(*) FROM build.build_members) <> before_row.build_members THEN
    RAISE EXCEPTION '1159 postcondition: the Build member roster moved from % to % rows across the rename', before_row.build_members, (SELECT count(*) FROM build.build_members);
  END IF;
END
$$;
--> statement-breakpoint

DROP TABLE _ws_removal_before;

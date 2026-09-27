SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ) THEN
    RAISE EXCEPTION '1417 precondition: intake_token column does not exist on build.projects — run 1415 and 1416 first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION '1417 precondition: intake_token has no column default — run 1416 first, or SET NOT NULL will break every insert that omits the column';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "build"."projects" WHERE intake_token IS NULL LIMIT 1
  ) THEN
    RAISE EXCEPTION '1417 precondition: build.projects has rows with intake_token IS NULL — run 1416 backfill first';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ADD CONSTRAINT "chk_projects_intake_token_not_null"
  CHECK (intake_token IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  VALIDATE CONSTRAINT "chk_projects_intake_token_not_null";
--> statement-breakpoint

ALTER TABLE "build"."projects" ALTER COLUMN "intake_token" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  DROP CONSTRAINT "chk_projects_intake_token_not_null";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_projects_org_intake_token"
  ON "build"."projects" ("org_id", "intake_token")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_projects_intake_token"
  ON "build"."projects" ("intake_token")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.resolve_project_org_id_by_intake_token(p_token text)
RETURNS TABLE(project_id integer, org_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, build, public
AS $$
  SELECT id, org_id
  FROM build.projects
  WHERE intake_token = p_token
    AND deleted_at IS NULL;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_project_org_id_by_intake_token(text) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_project_org_id_by_intake_token(text) TO %I', app_role);
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND is_nullable = 'NO'
  ), '1417 post-check: intake_token is still nullable on build.projects';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_projects_intake_token_not_null'
  ), '1417 post-check: the transitional CHECK constraint was not dropped';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'projects' AND indexname = 'uniq_projects_org_intake_token'
  ), '1417 post-check: uniq_projects_org_intake_token index was not created';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND tablename = 'projects' AND indexname = 'uniq_projects_intake_token'
  ), '1417 post-check: uniq_projects_intake_token index was not created';

  ASSERT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'resolve_project_org_id_by_intake_token'
      AND p.prosecdef
  ), '1417 post-check: app.resolve_project_org_id_by_intake_token is absent or not SECURITY DEFINER';

  ASSERT NOT has_function_privilege('public', 'app.resolve_project_org_id_by_intake_token(text)', 'EXECUTE'),
    '1417 post-check: PUBLIC can still execute the RLS-bypassing intake token resolver';
END $$;

SET statement_timeout = 0;
SET lock_timeout = '5s';

-- 0385 — resolve the org id for a public intake submission without exposing
-- the projects table to anonymous reads.
--
-- POST /public/intake/:projectId is @Public() and has no secret token, only a
-- serial (guessable) project id — that is the app's existing, pre-RLS design,
-- not something this migration should change. 0378 put projects behind
-- `org_id = app.current_org_id()`, so the one query this endpoint needs
-- (project id -> its org id) now 42501s.
--
-- Unlike job_postings (0384), there is no precedent here for treating the row
-- as already public: a `projects` policy arm keyed on the id would expose every
-- column of every project (title, client, description, ...) to anyone who can
-- guess a small integer, not just the one column this endpoint reads. A
-- SECURITY DEFINER function scoped to exactly that one column is the narrower
-- fix — it runs with the function owner's privileges for this lookup only and
-- returns nothing else about the row.

CREATE OR REPLACE FUNCTION app.resolve_project_org_id(p_project_id integer) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM projects WHERE id = p_project_id;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app.resolve_project_org_id(integer) IS
  'Returns only the org_id for a project, bypassing RLS for that single column so a public, token-less intake submission can resolve its tenant. Never expose any other project column through this path.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.resolve_project_org_id(integer) FROM PUBLIC;
--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(current_setting('app.bootstrap_role', true), 'streamline_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION app.resolve_project_org_id(integer) TO %I', app_role);
  END IF;
END $$;

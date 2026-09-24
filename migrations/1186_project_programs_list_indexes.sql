SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_created_page
  ON build.project_programs (org_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_updated_page
  ON build.project_programs (org_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_name_page
  ON build.project_programs (org_id, name, id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_owner
  ON build.project_programs (org_id, owner_id)
  WHERE deleted_at IS NULL AND owner_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_health
  ON build.project_programs (org_id, health)
  WHERE deleted_at IS NULL AND health IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_org_portfolio
  ON build.project_programs (org_id, portfolio_id)
  WHERE deleted_at IS NULL AND portfolio_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_program_projects_org_project_program
  ON build.program_projects (org_id, project_id, program_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_name_trgm
  ON build.project_programs USING gin (name gin_trgm_ops)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_programs_description_trgm
  ON build.project_programs USING gin (description gin_trgm_ops)
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.search_project_program_ids(p_q text, p_limit integer)
RETURNS SETOF integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, build, app
AS $$
  SELECT p.id
  FROM build.project_programs p
  WHERE p.org_id = app.current_org_id()
    AND p.deleted_at IS NULL
    AND (p.name ILIKE '%' || p_q || '%' OR p.description ILIKE '%' || p_q || '%')
  ORDER BY p.id
  LIMIT LEAST(GREATEST(p_limit, 1), 5001)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.search_project_program_ids(text, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION app.search_project_program_ids(text, integer) TO streamline_app;

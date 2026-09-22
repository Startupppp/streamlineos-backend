--
-- The test-cases and test-runs list endpoints now walk a keyset cursor:
--   test_cases: WHERE org_id = $1 AND project_id = $2 AND deleted_at IS NULL
--               [AND suite_id = $3] [AND priority = $4]
--               [AND automation_status = $5] [AND title ILIKE $6]
--               AND id > $cursor ORDER BY id ASC LIMIT 51
--   test_runs:  WHERE org_id = $1 AND project_id = $2 AND deleted_at IS NULL
--               [AND status = $3] AND id > $cursor ORDER BY id ASC LIMIT 51
--
-- The existing idx_test_cases_org_project_suite (org_id, project_id, suite_id)
-- and idx_test_runs_org_project_status (org_id, project_id, status) cannot
-- serve ORDER BY id, so every cursor page fell back to sorting the entire
-- project register. These lead with the tenant, then the project, then the
-- sort column in the direction the query reads it, and stay partial so
-- soft-deleted rows are not carried in the index.
--
-- CREATE INDEX is not CONCURRENTLY here because the runner wraps each
-- migration in a transaction; lock_timeout is the fence, matching 1133.
--

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_cases_org_project_id"
  ON "build"."test_cases" (org_id, project_id, id ASC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_test_runs_org_project_id"
  ON "build"."test_runs" (org_id, project_id, id ASC)
  WHERE deleted_at IS NULL;

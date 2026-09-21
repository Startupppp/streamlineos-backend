--
-- The risks and decisions list endpoints now walk a keyset cursor:
-- `WHERE org_id = $1 AND project_id = $2 AND deleted_at IS NULL [AND status = $3]
--  AND id < $cursor ORDER BY id DESC LIMIT 101`.
--
-- The existing `(org_id, project_id, status)` partial indexes cannot serve that
-- ORDER BY, so every page fell back to sorting the whole project's register.
-- These lead with the tenant, then the project, then the sort column in the
-- direction the query reads it, and stay partial so soft-deleted rows are not
-- carried in the index.
--
-- `CREATE INDEX` is not CONCURRENTLY here because the runner wraps each
-- migration in a transaction; `lock_timeout` is the fence, matching 1128.
--

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_risks_org_project_id_desc"
  ON "build"."project_risks" (org_id, project_id, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_decisions_org_project_id_desc"
  ON "build"."project_decisions" (org_id, project_id, id DESC)
  WHERE deleted_at IS NULL;

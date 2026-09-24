-- Build sidebar workspace scoping: managed products and project teams are now
-- filtered by (org_id, pm_workspace_id). Neither table had an index leading with
-- that pair, so the workspace Products and Teams destinations scanned the org.
-- Not CONCURRENTLY: `db:migrate` runs each file in a transaction, where
-- CONCURRENTLY is not allowed. `lock_timeout` is what stops a build queueing
-- behind a long lock. IF NOT EXISTS keeps re-runs safe.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_managed_products_org_workspace
  ON "build"."managed_products" (org_id, pm_workspace_id)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_teams_org_workspace
  ON "build"."project_teams" (org_id, pm_workspace_id)
  WHERE deleted_at IS NULL;

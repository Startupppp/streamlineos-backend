-- ============================================================================
-- 0331: PM Workspace ID — nullable column + composite indexes + candidate-key guard.
-- Fully idempotent: safe to apply on DBs where 0315 already added the columns.
-- ============================================================================

-- §1. pm_workspaces candidate-key constraint (composite FK target for child tables).
-- 0315 added this; guard is a no-op on live DBs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pm_workspaces_org_workspace'
  ) THEN
    ALTER TABLE pm_workspaces
      ADD CONSTRAINT uniq_pm_workspaces_org_workspace
      UNIQUE (org_id, pm_workspace_id);
  END IF;
END $$;

-- §2. Add pm_workspace_id column to Build child tables (IF NOT EXISTS = no-op on live DBs).
ALTER TABLE projects               ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE managed_products       ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_teams          ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_workspace_members ADD COLUMN IF NOT EXISTS pm_workspace_id text;

-- §3. Leading composite index (org_id, pm_workspace_id) for tenant-scoped queries.
CREATE INDEX IF NOT EXISTS idx_projects_org_pm_workspace
  ON projects (org_id, pm_workspace_id);
CREATE INDEX IF NOT EXISTS idx_managed_products_org_pm_workspace
  ON managed_products (org_id, pm_workspace_id);
CREATE INDEX IF NOT EXISTS idx_project_teams_org_pm_workspace
  ON project_teams (org_id, pm_workspace_id);
CREATE INDEX IF NOT EXISTS idx_project_workspace_members_org_pm_workspace
  ON project_workspace_members (org_id, pm_workspace_id);

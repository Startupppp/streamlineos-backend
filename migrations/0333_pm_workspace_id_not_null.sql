-- ============================================================================
-- 0333: PM Workspace ID — NOT NULL + composite tenant FK.
-- Run 0331 and 0332 first and verify the pre-flight query below returns all zeros.
-- SET statement_timeout = 0 is present because VALIDATE CONSTRAINT may scan large tables.
-- ============================================================================

SET statement_timeout = 0;

-- Pre-flight (read-only, run BEFORE applying this migration):
-- Any row returned here MUST be resolved via 0332 before proceeding.
-- SELECT 'projects'                  AS tbl, count(*) FROM projects               WHERE pm_workspace_id IS NULL
-- UNION ALL SELECT 'managed_products',       count(*) FROM managed_products       WHERE pm_workspace_id IS NULL
-- UNION ALL SELECT 'project_teams',          count(*) FROM project_teams          WHERE pm_workspace_id IS NULL
-- UNION ALL SELECT 'project_workspace_members', count(*) FROM project_workspace_members WHERE pm_workspace_id IS NULL;

-- §1. SET NOT NULL (guarded: no-op if the column is already NOT NULL).
DO $$
BEGIN
  IF NOT (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'projects'::regclass AND attname = 'pm_workspace_id') THEN
    ALTER TABLE projects ALTER COLUMN pm_workspace_id SET NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'managed_products'::regclass AND attname = 'pm_workspace_id') THEN
    ALTER TABLE managed_products ALTER COLUMN pm_workspace_id SET NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'project_teams'::regclass AND attname = 'pm_workspace_id') THEN
    ALTER TABLE project_teams ALTER COLUMN pm_workspace_id SET NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT (SELECT attnotnull FROM pg_attribute
          WHERE attrelid = 'project_workspace_members'::regclass AND attname = 'pm_workspace_id') THEN
    ALTER TABLE project_workspace_members ALTER COLUMN pm_workspace_id SET NOT NULL;
  END IF;
END $$;

-- §2. Composite tenant FK — NOT VALID so it does not re-scan existing rows inline
-- (VALIDATE below does that separately with a lighter lock). ON DELETE NO ACTION
-- means a pm_workspaces row cannot be deleted while child rows reference it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_projects_org_pm_workspace'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT fk_projects_org_pm_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id)
      ON DELETE NO ACTION
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_managed_products_org_pm_workspace'
  ) THEN
    ALTER TABLE managed_products
      ADD CONSTRAINT fk_managed_products_org_pm_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id)
      ON DELETE NO ACTION
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_teams_org_pm_workspace'
  ) THEN
    ALTER TABLE project_teams
      ADD CONSTRAINT fk_project_teams_org_pm_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id)
      ON DELETE NO ACTION
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_project_workspace_members_org_pm_workspace'
  ) THEN
    ALTER TABLE project_workspace_members
      ADD CONSTRAINT fk_project_workspace_members_org_pm_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id)
      ON DELETE NO ACTION
      NOT VALID;
  END IF;
END $$;

-- §3. Validate (SHARE UPDATE EXCLUSIVE — blocks only DDL, not DML).
-- Each statement is guarded: only validates if the constraint exists AND is not
-- yet validated. Re-running after full application is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_projects_org_pm_workspace' AND NOT convalidated
  ) THEN
    ALTER TABLE projects VALIDATE CONSTRAINT fk_projects_org_pm_workspace;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_managed_products_org_pm_workspace' AND NOT convalidated
  ) THEN
    ALTER TABLE managed_products VALIDATE CONSTRAINT fk_managed_products_org_pm_workspace;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_project_teams_org_pm_workspace' AND NOT convalidated
  ) THEN
    ALTER TABLE project_teams VALIDATE CONSTRAINT fk_project_teams_org_pm_workspace;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_project_workspace_members_org_pm_workspace' AND NOT convalidated
  ) THEN
    ALTER TABLE project_workspace_members VALIDATE CONSTRAINT fk_project_workspace_members_org_pm_workspace;
  END IF;
END $$;

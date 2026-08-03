-- ============================================================================
-- 0332: PM Workspace ID — backfill.
-- Idempotent: safe to re-run. No rows are double-inserted or overwritten.
-- ============================================================================

-- §1. Provision exactly one default pm_workspaces row for every org that has
-- Build data (projects, managed_products, project_teams, project_workspace_members)
-- or has the BUILD module enabled. The partial-unique index
-- uniq_pm_workspaces_org_default ensures at most one default per org, so a
-- re-run inserts nothing if the default already exists.
INSERT INTO pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status)
SELECT
  gen_random_uuid()::text,
  o.id,
  'Default Workspace',
  'default',
  true,
  'active'
FROM organizations o
WHERE NOT EXISTS (
    SELECT 1 FROM pm_workspaces w
    WHERE w.org_id = o.id AND w.is_default = true
  )
  AND (
    EXISTS (SELECT 1 FROM projects              p   WHERE p.org_id   = o.id)
    OR EXISTS (SELECT 1 FROM managed_products   m   WHERE m.org_id   = o.id)
    OR EXISTS (SELECT 1 FROM project_teams      t   WHERE t.org_id   = o.id)
    OR EXISTS (SELECT 1 FROM project_workspace_members pwm WHERE pwm.org_id = o.id)
    OR ('BUILD' = ANY(COALESCE(o.enabled_modules, '{}')))
    OR ('PROJECTS' = ANY(COALESCE(o.enabled_modules, '{}')))
  );

-- §2. Backfill pm_workspace_id on NULL rows in each Build child table.
-- UPDATE ... WHERE pm_workspace_id IS NULL makes each statement a no-op when
-- every row is already populated.
UPDATE projects p
  SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = p.org_id
    AND w.is_default = true
    AND p.pm_workspace_id IS NULL;

UPDATE managed_products m
  SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = m.org_id
    AND w.is_default = true
    AND m.pm_workspace_id IS NULL;

UPDATE project_teams t
  SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = t.org_id
    AND w.is_default = true
    AND t.pm_workspace_id IS NULL;

UPDATE project_workspace_members pwm
  SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = pwm.org_id
    AND w.is_default = true
    AND pwm.pm_workspace_id IS NULL;

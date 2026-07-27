-- ============================================================================
-- Wave 7 — PM Workspaces container (Organization → Product Management → PM Workspace).
-- Additive + idempotent (CREATE/ADD ... IF NOT EXISTS + guarded constraints) + provisioning
-- + backfill. Apply on the Neon BRANCH first. Matches the Drizzle schema (projects/pm-workspaces.ts,
-- projects/pm-workspace-memberships.ts) so a later db:generate/push sees no diff.
-- ============================================================================

-- §1. pm_workspaces (candidate key + one-default-per-org invariant) ----------
CREATE TABLE IF NOT EXISTS pm_workspaces (
  pm_workspace_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pm_workspaces_org_workspace') THEN
    ALTER TABLE pm_workspaces
      ADD CONSTRAINT uniq_pm_workspaces_org_workspace UNIQUE (org_id, pm_workspace_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pm_workspaces_org_default
  ON pm_workspaces (org_id) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pm_workspaces_org_slug ON pm_workspaces (org_id, slug);
CREATE INDEX IF NOT EXISTS idx_pm_workspaces_org ON pm_workspaces (org_id);

-- §2. pm_workspace_memberships (composite FK to pm_workspaces; references org membership) ----
CREATE TABLE IF NOT EXISTS pm_workspace_memberships (
  pm_workspace_membership_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pm_workspace_id text NOT NULL,
  organization_membership_id integer NOT NULL REFERENCES organization_members(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  added_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uniq_pm_ws_members_org_ws_member') THEN
    ALTER TABLE pm_workspace_memberships
      ADD CONSTRAINT uniq_pm_ws_members_org_ws_member UNIQUE (org_id, pm_workspace_id, organization_membership_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_pm_ws_members_org_workspace') THEN
    ALTER TABLE pm_workspace_memberships
      ADD CONSTRAINT fk_pm_ws_members_org_workspace
      FOREIGN KEY (org_id, pm_workspace_id)
      REFERENCES pm_workspaces (org_id, pm_workspace_id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_pm_ws_members_org_ws ON pm_workspace_memberships (org_id, pm_workspace_id);
CREATE INDEX IF NOT EXISTS idx_pm_ws_members_membership ON pm_workspace_memberships (organization_membership_id);

-- §3. Nullable pm_workspace_id on PM children (additive) ----------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE managed_products ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_teams ADD COLUMN IF NOT EXISTS pm_workspace_id text;
ALTER TABLE project_workspace_members ADD COLUMN IF NOT EXISTS pm_workspace_id text;

-- §4. Provisioning: exactly one default PM Workspace per ELIGIBLE org (has PM data OR
--     Product Management enabled). Idempotent via the partial-unique default + NOT EXISTS guard.
INSERT INTO pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status)
SELECT gen_random_uuid()::text, o.id, 'Default Workspace', 'default', true, 'active'
FROM organizations o
WHERE NOT EXISTS (
    SELECT 1 FROM pm_workspaces w WHERE w.org_id = o.id AND w.is_default = true
  )
  AND (
    EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id)
    OR EXISTS (SELECT 1 FROM managed_products m WHERE m.org_id = o.id)
    OR EXISTS (SELECT 1 FROM project_workspace_members pwm WHERE pwm.org_id = o.id)
    OR ('PROJECTS' = ANY(COALESCE(o.enabled_modules, '{}')))
  );

-- §5. Backfill pm_workspace_id on PM children to their org's default workspace ---------------
UPDATE projects p SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = p.org_id AND w.is_default = true AND p.pm_workspace_id IS NULL;
UPDATE managed_products m SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = m.org_id AND w.is_default = true AND m.pm_workspace_id IS NULL;
UPDATE project_teams t SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = t.org_id AND w.is_default = true AND t.pm_workspace_id IS NULL;
UPDATE project_workspace_members pwm SET pm_workspace_id = w.pm_workspace_id
  FROM pm_workspaces w
  WHERE w.org_id = pwm.org_id AND w.is_default = true AND pwm.pm_workspace_id IS NULL;

-- §6. Backfill pm_workspace_memberships from the existing org roster (project_workspace_members) ----
INSERT INTO pm_workspace_memberships (pm_workspace_membership_id, org_id, pm_workspace_id, organization_membership_id, role)
SELECT gen_random_uuid()::text, pwm.org_id, w.pm_workspace_id, om.id, 'member'
FROM project_workspace_members pwm
JOIN pm_workspaces w ON w.org_id = pwm.org_id AND w.is_default = true
JOIN organization_members om ON om.org_id = pwm.org_id AND om.user_id = pwm.user_id
ON CONFLICT (org_id, pm_workspace_id, organization_membership_id) DO NOTHING;

-- ============================================================================
-- VERIFY (read-only): default-workspace count == eligible-org count; no PM child left unbackfilled.
--   SELECT count(*) FROM pm_workspaces WHERE is_default = true;
--   SELECT count(*) FROM projects WHERE pm_workspace_id IS NULL;   -- expect 0 for eligible orgs
-- Deferred (Wave 7 follow-up): composite FKs projects/managed_products/project_teams
--   (org_id, pm_workspace_id) → pm_workspaces(org_id, pm_workspace_id) once pm_workspace_id is NOT NULL.
-- ============================================================================

-- ============================================================================
-- Branch sync — create the 2 project-team tables present in the Drizzle schema
-- (src/db/schema/project-teams.ts) but missing from the branched database, which
-- caused 42P01 "relation does not exist" crashes at runtime. Additive + idempotent.
-- Definitions mirror project-teams.ts exactly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_workspace_members (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  added_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_workspace_members_org_user
  ON project_workspace_members (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_project_workspace_members_org
  ON project_workspace_members (org_id);

CREATE TABLE IF NOT EXISTS project_team_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id integer NOT NULL REFERENCES project_teams(id) ON DELETE CASCADE,
  added_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_team_assignments_project_team
  ON project_team_assignments (project_id, team_id);
CREATE INDEX IF NOT EXISTS idx_project_team_assignments_org
  ON project_team_assignments (org_id);
CREATE INDEX IF NOT EXISTS idx_project_team_assignments_team
  ON project_team_assignments (team_id);
CREATE INDEX IF NOT EXISTS idx_project_team_assignments_project
  ON project_team_assignments (project_id);

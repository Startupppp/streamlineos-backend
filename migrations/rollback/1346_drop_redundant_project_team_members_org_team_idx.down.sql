SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_team_members_org_team
  ON build.project_team_members (org_id, team_id);

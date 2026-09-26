SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_team_members') IS NULL THEN
    RAISE EXCEPTION '1345 precondition: build.project_team_members is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_project_team_members_org_team
  ON build.project_team_members (org_id, team_id);
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_team_members'
      AND indexname = 'idx_project_team_members_org_team'
  ), '1345 post-check: idx_project_team_members_org_team was not created';
END $$;

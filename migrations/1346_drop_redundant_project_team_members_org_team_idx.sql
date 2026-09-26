SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_team_members'
      AND indexname = 'idx_project_team_members_org_team_joined'
  ) THEN
    RAISE EXCEPTION '1346 precondition: idx_project_team_members_org_team_joined is absent, so (org_id, team_id) is not covered by a prefix and must not be dropped';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_team_members_org_team;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_team_members'
      AND indexname = 'idx_project_team_members_org_team'
  ), '1346 post-check: the redundant index was not dropped';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_team_members'
      AND indexname = 'idx_project_team_members_org_team_joined'
  ), '1346 post-check: the covering composite must survive, it is what serves the org_id/team_id lookup';
END $$;

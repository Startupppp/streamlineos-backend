SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_team_members'
      AND indexname = 'idx_project_team_members_org_team'
  ) THEN
    RAISE EXCEPTION '1345-rollback precondition: idx_project_team_members_org_team does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_project_team_members_org_team;

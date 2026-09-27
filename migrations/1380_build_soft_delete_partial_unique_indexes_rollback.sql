-- 1380-rollback — Restore seven unique indexes to cover all rows (remove partial predicate)

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_teams'
      AND indexname = 'uniq_project_teams_org_key'
  ) THEN
    RAISE EXCEPTION '1380-rollback precondition: uniq_project_teams_org_key does not exist — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key
  ON build.project_teams (org_id, key);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number
  ON build.tickets (project_id, ticket_number);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number
  ON build.project_risks (project_id, risk_number);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number
  ON build.project_decisions (project_id, decision_number);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number
  ON build.change_requests (project_id, cr_number);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number
  ON build.project_forms (project_id, form_number);
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key
  ON build.feedbucket_widgets (public_key);

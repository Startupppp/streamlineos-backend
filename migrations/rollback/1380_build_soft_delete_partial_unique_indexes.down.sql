SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND indexname = 'uniq_tickets_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ) THEN
    RAISE EXCEPTION '1380-rollback precondition: uniq_tickets_project_number partial index not found — rollback requires forward migration 1380 to have completed';
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key_old
  ON build.project_teams (org_id, key);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_project_teams_org_key_old RENAME TO uniq_project_teams_org_key;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number_old
  ON build.tickets (project_id, ticket_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_tickets_project_number_old RENAME TO uniq_tickets_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number_old
  ON build.project_risks (project_id, risk_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_risks_project_number_old RENAME TO uq_project_risks_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number_old
  ON build.project_decisions (project_id, decision_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_decisions_project_number_old RENAME TO uq_project_decisions_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number_old
  ON build.change_requests (project_id, cr_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_change_requests_project_number_old RENAME TO uq_change_requests_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number_old
  ON build.project_forms (project_id, form_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_forms_project_number_old RENAME TO uq_project_forms_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key_old
  ON build.feedbucket_widgets (public_key);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key_old RENAME TO uniq_feedbucket_widgets_public_key;

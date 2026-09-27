SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_teams') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_teams is absent';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.tickets is absent';
  END IF;
  IF to_regclass('build.project_risks') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_risks is absent';
  END IF;
  IF to_regclass('build.project_decisions') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_decisions is absent';
  END IF;
  IF to_regclass('build.change_requests') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.change_requests is absent';
  END IF;
  IF to_regclass('build.project_forms') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.project_forms is absent';
  END IF;
  IF to_regclass('build.feedbucket_widgets') IS NULL THEN
    RAISE EXCEPTION '1380 precondition: build.feedbucket_widgets is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key_new
  ON build.project_teams (org_id, key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_project_teams_org_key_new RENAME TO uniq_project_teams_org_key;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number_new
  ON build.tickets (project_id, ticket_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_tickets_project_number_new RENAME TO uniq_tickets_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number_new
  ON build.project_risks (project_id, risk_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_risks_project_number_new RENAME TO uq_project_risks_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number_new
  ON build.project_decisions (project_id, decision_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_decisions_project_number_new RENAME TO uq_project_decisions_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number_new
  ON build.change_requests (project_id, cr_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_change_requests_project_number_new RENAME TO uq_change_requests_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number_new
  ON build.project_forms (project_id, form_number)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_forms_project_number_new RENAME TO uq_project_forms_project_number;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key_new
  ON build.feedbucket_widgets (public_key)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key_new RENAME TO uniq_feedbucket_widgets_public_key;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_teams'
      AND indexname = 'uniq_project_teams_org_key'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_project_teams_org_key is not partial';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND indexname = 'uniq_project_teams_org_key_new'
  ), '1380 post-check: temp index uniq_project_teams_org_key_new still exists';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'tickets'
      AND indexname = 'uniq_tickets_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_tickets_project_number is not partial';

  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build' AND indexname = 'uniq_tickets_project_number_new'
  ), '1380 post-check: temp index uniq_tickets_project_number_new still exists';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_risks'
      AND indexname = 'uq_project_risks_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_risks_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_decisions'
      AND indexname = 'uq_project_decisions_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_decisions_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'change_requests'
      AND indexname = 'uq_change_requests_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_change_requests_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'project_forms'
      AND indexname = 'uq_project_forms_project_number'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uq_project_forms_project_number is not partial';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build'
      AND tablename = 'feedbucket_widgets'
      AND indexname = 'uniq_feedbucket_widgets_public_key'
      AND indexdef LIKE '%deleted_at IS NULL%'
  ), '1380 post-check: uniq_feedbucket_widgets_public_key is not partial';
END $$;

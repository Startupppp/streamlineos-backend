-- 1380-rollback — Restore seven partial unique indexes to full unique indexes
--
-- This rollback uses the same 3-step swap strategy as the forward migration:
-- CREATE full index under _old name / DROP canonical partial / RENAME _old → canonical.
-- A uniqueness guard remains active at all times during the rollback.
--
-- WARNING: If any key reuse occurred between applying migration 1380 and running
-- this rollback (e.g. a deleted team key was reassigned), CREATE UNIQUE INDEX
-- will fail with a duplicate-key violation on those rows.  Identify and resolve
-- duplicates before rolling back:
--
--   SELECT org_id, key, count(*) FROM build.project_teams
--     WHERE deleted_at IS NULL GROUP BY org_id, key HAVING count(*) > 1;
--
--   SELECT project_id, ticket_number, count(*) FROM build.tickets
--     WHERE deleted_at IS NULL GROUP BY project_id, ticket_number HAVING count(*) > 1;
--
-- (repeat for risks, decisions, change_requests, project_forms, feedbucket_widgets)

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

-- ====== 1. project_teams ======

CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_teams_org_key_old
  ON build.project_teams (org_id, key);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_project_teams_org_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_project_teams_org_key_old RENAME TO uniq_project_teams_org_key;
--> statement-breakpoint

-- ====== 2. tickets ======

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tickets_project_number_old
  ON build.tickets (project_id, ticket_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_tickets_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_tickets_project_number_old RENAME TO uniq_tickets_project_number;
--> statement-breakpoint

-- ====== 3. project_risks ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_risks_project_number_old
  ON build.project_risks (project_id, risk_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_risks_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_risks_project_number_old RENAME TO uq_project_risks_project_number;
--> statement-breakpoint

-- ====== 4. project_decisions ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_decisions_project_number_old
  ON build.project_decisions (project_id, decision_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_decisions_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_decisions_project_number_old RENAME TO uq_project_decisions_project_number;
--> statement-breakpoint

-- ====== 5. change_requests ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_change_requests_project_number_old
  ON build.change_requests (project_id, cr_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_change_requests_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_change_requests_project_number_old RENAME TO uq_change_requests_project_number;
--> statement-breakpoint

-- ====== 6. project_forms ======

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_forms_project_number_old
  ON build.project_forms (project_id, form_number);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uq_project_forms_project_number;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uq_project_forms_project_number_old RENAME TO uq_project_forms_project_number;
--> statement-breakpoint

-- ====== 7. feedbucket_widgets ======

CREATE UNIQUE INDEX IF NOT EXISTS uniq_feedbucket_widgets_public_key_old
  ON build.feedbucket_widgets (public_key);
--> statement-breakpoint
DROP INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key;
--> statement-breakpoint
ALTER INDEX IF EXISTS build.uniq_feedbucket_widgets_public_key_old RENAME TO uniq_feedbucket_widgets_public_key;

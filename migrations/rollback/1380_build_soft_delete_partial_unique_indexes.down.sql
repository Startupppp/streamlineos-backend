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

DO $$
DECLARE
  rec record;
  report text := '';
  groups integer := 0;
BEGIN
  FOR rec IN
    SELECT 'build.project_teams (org_id, key)' AS ident, org_id::text AS a, key::text AS b, count(*) AS n
      FROM build.project_teams GROUP BY org_id, key HAVING count(*) > 1
    UNION ALL
    SELECT 'build.tickets (project_id, ticket_number)', project_id::text, ticket_number::text, count(*)
      FROM build.tickets GROUP BY project_id, ticket_number HAVING count(*) > 1
    UNION ALL
    SELECT 'build.project_risks (project_id, risk_number)', project_id::text, risk_number::text, count(*)
      FROM build.project_risks GROUP BY project_id, risk_number HAVING count(*) > 1
    UNION ALL
    SELECT 'build.project_decisions (project_id, decision_number)', project_id::text, decision_number::text, count(*)
      FROM build.project_decisions GROUP BY project_id, decision_number HAVING count(*) > 1
    UNION ALL
    SELECT 'build.change_requests (project_id, cr_number)', project_id::text, cr_number::text, count(*)
      FROM build.change_requests GROUP BY project_id, cr_number HAVING count(*) > 1
    UNION ALL
    SELECT 'build.project_forms (project_id, form_number)', project_id::text, form_number::text, count(*)
      FROM build.project_forms GROUP BY project_id, form_number HAVING count(*) > 1
    UNION ALL
    SELECT 'build.feedbucket_widgets (public_key)', public_key::text, '', count(*)
      FROM build.feedbucket_widgets GROUP BY public_key HAVING count(*) > 1
  LOOP
    groups := groups + 1;
    report := report || format('%s -> (%s,%s) x%s | ', rec.ident, rec.a, rec.b, rec.n);
  END LOOP;

  IF groups > 0 THEN
    RAISE EXCEPTION '1380-rollback refuses to restore full uniqueness: % reused key group(s) exist once soft-deleted rows are counted. Resolve or hard-delete these before rolling back. Collisions: %', groups, report;
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

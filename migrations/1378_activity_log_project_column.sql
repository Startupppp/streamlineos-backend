-- 1378: add project_id to ticket_activity_log, backfill from tickets, add partial index.
--
-- getProjectActivity in projects-activity-feed.service.ts currently pushes the project
-- constraint into the tickets inner join: every page of the project feed scans all activity
-- rows for the organisation and then filters by project through the join. The cost grows with
-- every other project's event volume, not with the viewed project's.
--
-- This is the expand half of the expand/contract pattern (contract is ticket 17). No reader
-- depends on the new column yet. The writer (logTicketActivity / logTicketFieldChanges) will
-- start populating it in the same code deployment so new rows carry the project from insertion
-- rather than relying solely on the backfill.
--
-- Backfill: a single UPDATE is used because project_id is nullable (no NOT NULL constraint).
-- Per BE-61 a batched approach is required only when adding NOT NULL; the UPDATE acquires
-- row-level locks and completes without a table-wide write lock once it starts.
--
-- Partial index: (org_id, project_id, id) WHERE project_id IS NOT NULL. The partial predicate
-- keeps the index small (only rows that have been populated), and the column order matches the
-- query plan for getProjectActivity: seek on (org_id, project_id), range scan descending on id.
--
-- Not CONCURRENTLY: db:migrate runs each statement in a transaction where CONCURRENTLY is not
-- allowed. lock_timeout limits the wait to acquire the lock.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build_events.ticket_activity_log') IS NULL THEN
    RAISE EXCEPTION '1378 precondition: build_events.ticket_activity_log is absent';
  END IF;
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1378 precondition: build.tickets is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build_events.ticket_activity_log
  ADD COLUMN IF NOT EXISTS project_id integer;
--> statement-breakpoint

UPDATE build_events.ticket_activity_log tal
SET project_id = t.project_id
FROM build.tickets t
WHERE t.org_id = tal.org_id
  AND t.id = tal.ticket_id
  AND tal.project_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ticket_activity_log_org_project
  ON build_events.ticket_activity_log (org_id, project_id, id)
  WHERE project_id IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build_events'
      AND table_name = 'ticket_activity_log'
      AND column_name = 'project_id'
  ), '1378 post-check: project_id column was not added to build_events.ticket_activity_log';

  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'build_events'
      AND tablename = 'ticket_activity_log'
      AND indexname = 'idx_ticket_activity_log_org_project'
  ), '1378 post-check: idx_ticket_activity_log_org_project was not created';
END $$;

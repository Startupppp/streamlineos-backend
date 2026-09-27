-- Rollback 1378: drop the project_id column and its partial index from ticket_activity_log.
-- No data is lost beyond the denormalized project reference, which is fully reconstructable
-- by re-running the backfill in 1378.

SET lock_timeout = '5s';

DROP INDEX IF EXISTS build_events."idx_ticket_activity_log_org_project";

ALTER TABLE build_events.ticket_activity_log
  DROP COLUMN IF EXISTS project_id;

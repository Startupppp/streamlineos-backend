SET lock_timeout = '5s';

DROP INDEX IF EXISTS build_events."idx_ticket_activity_log_org_project";

ALTER TABLE build_events.ticket_activity_log
  DROP COLUMN IF EXISTS project_id;

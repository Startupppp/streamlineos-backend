SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX idx_sprints_org_project_velocity_cursor
ON build.sprints (org_id, project_id, start_date DESC, id DESC)
WHERE deleted_at IS NULL AND status IN ('ACTIVE', 'COMPLETED');

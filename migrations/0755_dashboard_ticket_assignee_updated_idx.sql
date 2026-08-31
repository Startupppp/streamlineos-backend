SET lock_timeout = '5s';

CREATE INDEX idx_tickets_org_assignee_updated
ON build.tickets (org_id, assignee_id, updated_at DESC)
WHERE deleted_at IS NULL;

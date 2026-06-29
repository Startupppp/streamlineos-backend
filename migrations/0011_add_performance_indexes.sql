-- Performance indexes for high-volume query paths
-- Migration: 0011_add_performance_indexes

-- Leads: filtered list queries (org + assignee + status)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_org_assigned_status
  ON leads (org_id, assigned_to_id, status);

-- Leads: SLA cron (status = 'NEW' partial index)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_new_status_created
  ON leads (status, created_at)
  WHERE status = 'NEW';

-- Tickets: most ticket queries filter by project + status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_project_status
  ON tickets (project_id, status);

-- Tickets: sprint assignment queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_sprint
  ON tickets (sprint_id)
  WHERE sprint_id IS NOT NULL;

-- Timesheets: user + date queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_timesheets_user_date
  ON time_entries (user_id, date);

-- Chat: message polling (channel ordered by time)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_channel_created
  ON chat_messages (channel_id, created_at DESC);

-- Notifications: unread badge count
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, is_read)
  WHERE is_read = false;

-- Deals: pipeline view (org + stage)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_org_stage
  ON deals (org_id, stage);

-- Audit logs: recent activity feed
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_org_created
  ON audit_logs (org_id, created_at DESC);

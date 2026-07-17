-- Migration 0288: add missing composite indexes on hot query paths
-- UNAPPLIED — run manually after 0287_drop_password_columns.sql

-- attendance: orgId + userId + date range queries (HR AI, payroll, analytics, per-employee history)
CREATE INDEX IF NOT EXISTS idx_attendance_org_user_date
  ON attendance (org_id, user_id, date);

-- wfh_requests: orgId + status (pending list for managers) and orgId + userId + status (per-user filter)
CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_status
  ON wfh_requests (org_id, status);

CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_user_status
  ON wfh_requests (org_id, user_id, status);

-- department_members: userId lookup (access service resolves dept membership by userId)
CREATE INDEX IF NOT EXISTS idx_dept_members_user_id
  ON department_members (user_id);

-- helpdesk_tickets: orgId + assigneeId filter (assignee workload queries)
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_org_assignee
  ON helpdesk_tickets (org_id, assignee_id);

-- leads: orgId + assignedToId + status (assigned-to filter with status, used by CRM AI + chat assistant)
CREATE INDEX IF NOT EXISTS idx_leads_org_assigned_status
  ON leads (org_id, assigned_to_id, status);

-- ticket_activity_log: orgId + ticketId + id (org-scoped ticket history, orgId not previously covered)
CREATE INDEX IF NOT EXISTS idx_ticket_activity_log_org_ticket
  ON ticket_activity_log (org_id, ticket_id, id);

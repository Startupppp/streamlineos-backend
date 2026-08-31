SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_audit_events_org_created
  ON timesheet_audit_events (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_exports_org_created
  ON timesheet_exports (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_channel_members_org_membership
  ON chat_channel_members (org_id, membership_id, archived_at);

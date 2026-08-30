SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheets_org_locked_by_membership
  ON timesheets (org_id, locked_by_membership_id);

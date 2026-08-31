SET lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_events_org_id ON calendar_events (org_id, id);

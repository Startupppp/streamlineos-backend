SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'org';

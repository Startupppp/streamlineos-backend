DROP INDEX IF EXISTS "idx_ticket_activity_log_ticket";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_activity_log_ticket_recent" ON "ticket_activity_log" ("ticket_id","id");

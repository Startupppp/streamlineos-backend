SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_order" ON "tickets" ("org_id","project_id","order");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_assignee_status" ON "tickets" ("org_id","assignee_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tickets_org_assignee_due_open" ON "tickets" ("org_id","assignee_id","due_date") WHERE "status" <> 'DONE';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tickets_assignee";

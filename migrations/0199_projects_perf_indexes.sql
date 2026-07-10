CREATE INDEX IF NOT EXISTS "idx_tickets_org_project" ON "tickets" ("org_id","project_id");
CREATE INDEX IF NOT EXISTS "idx_tickets_cycle" ON "tickets" ("cycle_id");
CREATE INDEX IF NOT EXISTS "idx_tickets_parent" ON "tickets" ("parent_ticket_id");

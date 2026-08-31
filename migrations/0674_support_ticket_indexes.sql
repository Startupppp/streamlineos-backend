-- Replace the org-less assignee index with an org_id-leading composite so the RLS policy
-- (org_id = app.current_org_id()) is satisfied by the index and the planner can use it
-- for "assigned to me" queries without a full table scan.
--
-- Add a queue+status+priority composite for the queue list view, which filters by
-- org + queue + status and orders by priority then SLA deadline.
--
-- Not CONCURRENTLY: db:migrate wraps each file in a transaction and CONCURRENTLY is
-- rejected inside one (same reasoning as 0475/0497).
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_support_tickets_assignee";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_tickets_org_assignee"
  ON "support_tickets" ("org_id", "assignee_id", "created_at" DESC);
--> statement-breakpoint
-- Dropped in favour of idx_support_tickets_org_queue_status_priority so queue views
-- (org + queue + open statuses + priority ordering) can use a single index scan.
DROP INDEX IF EXISTS "idx_support_tickets_queue";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_support_tickets_org_queue_status_priority"
  ON "support_tickets" ("org_id", "queue_id", "status", "priority", "created_at");

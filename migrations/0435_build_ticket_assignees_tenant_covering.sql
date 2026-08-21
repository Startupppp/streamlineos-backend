-- Tenant-led covering index for the participation check in scoped Build reads. `org_id` must be IN
-- the index or the RLS predicate forces a heap fetch and the planner refuses it outright: see
-- backend/CLAUDE.md §7. Plain CREATE INDEX, not CONCURRENTLY — the runner applies each file as one
-- implicit transaction.
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ticket_assignees_org_user_ticket" ON "build"."ticket_assignees" ("org_id","user_id","ticket_id");

-- Rollback for 0126_build_ticket_hot_path_indexes
-- Reverses: +idx_tickets_org_project_order, +idx_tickets_org_assignee_status,
--           +partial idx_tickets_org_assignee_due_open, -idx_tickets_assignee
--
-- NOTE: CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction.
-- The non-concurrent form is used here so the script can be verified in a
-- transaction (BEGIN … ROLLBACK). In production, run outside a transaction
-- if the table is large, or accept the brief lock.

SET lock_timeout = '5s';

-- 1. Restore the index that 0126 dropped.
CREATE INDEX IF NOT EXISTS "idx_tickets_assignee"
  ON "tickets" ("assignee_id");

-- 2. Drop the three indexes that 0126 added.
DROP INDEX IF EXISTS "idx_tickets_org_project_order";
DROP INDEX IF EXISTS "idx_tickets_org_assignee_status";
DROP INDEX IF EXISTS "idx_tickets_org_assignee_due_open";

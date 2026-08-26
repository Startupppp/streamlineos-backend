-- 0497 — open a ticket by its human key in one indexed lookup (c13-01)
--
-- Resolving PROJ-123 matched on (project_id, ticket_number) with no index that
-- leads with org_id. Under RLS the policy adds `org_id = app.current_org_id()`,
-- which is not leakproof, so the planner will not use an index that omits the
-- tenant column — it cannot prove the user qual is safe to run first. Leading
-- with org_id is what makes the index usable at all, not merely faster.
--
-- Partial on `deleted_at IS NULL` because every read filters soft-deleted rows,
-- so dead tickets need not sit in the index.
--
-- NOTE ON CONCURRENCY: on a large production `tickets` table this should be
-- created as CREATE INDEX CONCURRENTLY, which cannot run inside a transaction
-- block. The statement below deliberately omits CONCURRENTLY so it runs inside
-- the standard migration transaction and reproduces on a cold build. On a live
-- database, run the CONCURRENTLY form by hand first; the IF NOT EXISTS guard
-- then makes this migration a no-op. Same arrangement as 0374.

SET statement_timeout = 0;
--> statement-breakpoint

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_number"
  ON "build"."tickets" ("org_id", "project_id", "ticket_number")
  WHERE "deleted_at" IS NULL;

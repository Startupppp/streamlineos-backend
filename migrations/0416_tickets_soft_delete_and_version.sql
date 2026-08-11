-- SCH-006: soft delete on tickets
-- Adds deleted_at (nullable timestamp) so deletes become a status mutation that
-- preserves history. All list/read queries must add WHERE deleted_at IS NULL.
-- Soft-deleted rows still hold their ticket number (uniq_tickets_project_number
-- covers deleted rows intentionally — numbers are permanent).
--
-- SCH-005: optimistic concurrency control
-- Adds version (integer NOT NULL DEFAULT 1). Every update increments version.
-- Callers that supply a version get a 409 if version has moved; callers that
-- omit it update unconditionally (backwards-compatible).
--
-- Index: the existing idx_tickets_org_project_rank is replaced with a partial
-- index (WHERE deleted_at IS NULL) so the hot-path board/rank queries only scan
-- live rows. The old non-partial index is dropped first.
--
-- NOT NULL + DEFAULT on a 204k-row table is a metadata-only operation in
-- Postgres 11+, no rewrite required.

SET lock_timeout = '5s';

ALTER TABLE "tickets" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_tickets_org_project_rank";
--> statement-breakpoint
CREATE INDEX "idx_tickets_org_project_rank" ON "tickets" ("org_id", "project_id", "rank") WHERE deleted_at IS NULL;

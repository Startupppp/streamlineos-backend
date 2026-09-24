-- Rollback for migration 1155.
--
-- Drops the four indexes. The two columns are deliberately NOT dropped.
--
-- build.cycles.goal and build.cycles.deleted_at were created by
-- migrations/sql/a-sprint-cycle-01-expand.sql, which is outside the journal. 1155 only adds
-- them IF NOT EXISTS, so on any database where phase 01 ran it created nothing and has nothing
-- to undo. Dropping them here would therefore destroy columns this migration did not create,
-- and on a soft-delete column that would be data loss rather than a schema revert.
--
-- To remove the columns on a database where 1155 genuinely created them, use
-- a-sprint-cycle-01-expand-rollback.sql, which owns them.
--
-- Rolling this back leaves queries that filter deleted_at correct but unindexed.

SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "build_events"."idx_sprint_scope_events_org_cycle_created";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_tickets_org_cycle_live";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_cycles_org_project_velocity_cursor";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_cycles_project_status_live";

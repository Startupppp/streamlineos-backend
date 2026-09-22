-- Rollback of a-sprint-cycle-06-rename-scope-events.sql. Restores the physical names the Drizzle
-- declaration carried before phase 06, so a deployment that still reads sprint_scope_events resolves.
-- Run this before a-sprint-cycle-05-drop-rollback.sql, not after: that file recreates build.sprints and
-- says so in its own header.
--
-- Carries the same lockstep condition in reverse. Run it together with the deploy that puts
-- src/db/schema/build/sprint-events.ts back to buildEvents.table("sprint_scope_events") and
-- pgEnum("sprint_scope_event_type"), or the burnup report breaks the other way.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TYPE "cycle_scope_event_type" RENAME TO "sprint_scope_event_type";
--> statement-breakpoint

ALTER TABLE "build_events"."cycle_scope_events" RENAME TO "sprint_scope_events";

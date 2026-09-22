-- Phase 2 / Workstream A / P0 #6 -- Sprint-Cycle consolidation, phase 06 (RENAME).
-- Split out of a-sprint-cycle-05-drop.sql on 2026-09-22. Both statements are cosmetic: they finish the
-- vocabulary change that phases 01-05 made real. Nothing depends on them, and phase 05 is complete and
-- correct without them.
--
-- They are separated because a RENAME has no overlap window. Dropping a column or a table is safe once
-- no source file references it, because an unreferenced object costs a deployed reader nothing. A rename
-- is different: the old name stops resolving at the instant the new one starts, so every already-deployed
-- reader of build_events.sprint_scope_events breaks the moment this commits. At the time of writing that
-- is src/modules/build/core/projects-reports.service.ts, which builds the burnup report, reached through
-- src/db/schema/build/sprint-events.ts.
--
-- PRECONDITION, and it is not optional: a build in which src/db/schema/build/sprint-events.ts declares
-- buildEvents.table("cycle_scope_events") and pgEnum("cycle_scope_event_type") must already be deployed,
-- and this file applied in the same maintenance step. Applying it against the current declaration raises
-- relation "build_events"."sprint_scope_events" does not exist on every burnup request.
--
-- If that lockstep is not available, do not run this file. Leaving the physical names as they are costs
-- nothing but a stale word in the catalog.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build_events"."sprint_scope_events" RENAME TO "cycle_scope_events";
--> statement-breakpoint

ALTER TYPE "sprint_scope_event_type" RENAME TO "cycle_scope_event_type";

-- Phase 2 / Workstream B / P0 #7 — rollback of b-qa-bug-02-backfill.sql.
--
-- Run the whole file inside ONE transaction. It removes every row the backfill
-- created and leaves build.bugs, which the backfill never modified, as the
-- single source of truth again.
--
-- Scope is bounded by build.bug_work_item_map: only work items this migration
-- created are touched, so a defect a user filed through the canonical route
-- after cutover is never deleted. Run this before
-- b-qa-bug-01-expand-rollback.sql.
--
-- Not reversible in the other direction beyond re-running the backfill, which
-- allocates fresh ticket numbers. Deep links to the migrated work items break.

SET lock_timeout = '5s';
--> statement-breakpoint

UPDATE build.test_run_results r
SET linked_work_item_id = NULL,
    updated_at = now()
FROM build.bug_work_item_map m
WHERE m.org_id = r.org_id
  AND m.work_item_id = r.linked_work_item_id
  AND r.linked_work_item_id IS NOT NULL;
--> statement-breakpoint

DELETE FROM build_events.ticket_activity_log l
USING build.bug_work_item_map m
WHERE l.org_id = m.org_id AND l.ticket_id = m.work_item_id;
--> statement-breakpoint

DELETE FROM build.work_item_relations r
USING build.bug_work_item_map m
WHERE r.org_id = m.org_id
  AND (r.work_item_id = m.work_item_id OR r.related_work_item_id = m.work_item_id);
--> statement-breakpoint

DELETE FROM build.work_item_qa_details q
USING build.bug_work_item_map m
WHERE q.org_id = m.org_id AND q.work_item_id = m.work_item_id;
--> statement-breakpoint

DELETE FROM build.tickets t
USING build.bug_work_item_map m
WHERE t.org_id = m.org_id AND t.id = m.work_item_id;
--> statement-breakpoint

DELETE FROM build.bug_work_item_map;

-- Phase 2 / Workstream B / P0 #7 — QA bug consolidation, VERIFY phase.
--
-- Read-only. Run after b-qa-bug-02-backfill.sql and before
-- b-qa-bug-04-contract-freeze.sql. Every query below must return the stated
-- result; any other result blocks the contraction.
--
-- Not a drizzle migration and never promoted into migrations/.

SET lock_timeout = '5s';
--> statement-breakpoint

-- Expect 0. A bug with no identity-map row was not migrated.
SELECT count(*) AS unmapped_bugs
FROM build.bugs b
WHERE NOT EXISTS (
  SELECT 1 FROM build.bug_work_item_map m
  WHERE m.org_id = b.org_id AND m.bug_id = b.id
);
--> statement-breakpoint

-- Expect 0. Structurally impossible while fk_bugs_org_project is VALID; a
-- non-zero count means that constraint is NOT VALID and has legacy violators,
-- which is the only way a bug can outlive its project.
SELECT count(*) AS bugs_with_missing_project
FROM build.bugs b
WHERE NOT EXISTS (
  SELECT 1 FROM build.projects p
  WHERE p.org_id = b.org_id AND p.id = b.project_id
);
--> statement-breakpoint

-- Expect 0. Every mapped work item must exist, be typed BUG, and sit in the
-- same project as the bug it came from.
SELECT count(*) AS work_item_identity_mismatches
FROM build.bug_work_item_map m
LEFT JOIN build.tickets t ON t.org_id = m.org_id AND t.id = m.work_item_id
WHERE t.id IS NULL
   OR t.type <> 'BUG'
   OR t.project_id IS DISTINCT FROM m.project_id
   OR t.ticket_number IS DISTINCT FROM m.ticket_number;
--> statement-breakpoint

-- Expect 0. Two work items sharing one per-project number would mean the
-- allocation collided with a pre-existing ticket.
SELECT count(*) AS duplicate_ticket_numbers
FROM (
  SELECT t.project_id, t.ticket_number
  FROM build.tickets t
  WHERE t.project_id IS NOT NULL
  GROUP BY t.project_id, t.ticket_number
  HAVING count(*) > 1
) AS dupes;
--> statement-breakpoint

-- Expect 0. The counter must never hand out a number already in use.
SELECT count(*) AS counters_behind_max
FROM build.project_ticket_counters c
WHERE c.next_ticket_number <= COALESCE((
  SELECT MAX(t.ticket_number) FROM build.tickets t
  WHERE t.org_id = c.org_id AND t.project_id = c.project_id
), 0);
--> statement-breakpoint

-- Expect 0. Every mapped work item needs exactly one QA sidecar row.
SELECT count(*) AS work_items_without_sidecar
FROM build.bug_work_item_map m
WHERE NOT EXISTS (
  SELECT 1 FROM build.work_item_qa_details q
  WHERE q.org_id = m.org_id AND q.work_item_id = m.work_item_id
);
--> statement-breakpoint

-- Expect 0. Field-level parity for every column that moved to the sidecar.
SELECT count(*) AS sidecar_field_mismatches
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.work_item_qa_details q
  ON q.org_id = m.org_id AND q.work_item_id = m.work_item_id
WHERE q.qa_state IS DISTINCT FROM b.status
   OR q.severity IS DISTINCT FROM b.severity
   OR q.steps_to_reproduce IS DISTINCT FROM b.steps_to_reproduce
   OR q.expected_result IS DISTINCT FROM b.expected_result
   OR q.actual_result IS DISTINCT FROM b.actual_result
   OR q.environment IS DISTINCT FROM b.environment
   OR q.browser_device IS DISTINCT FROM b.browser_device
   OR q.affected_release_id IS DISTINCT FROM b.affected_release_id
   OR q.fixed_release_id IS DISTINCT FROM b.fixed_release_id
   OR q.qa_owner_user_id IS DISTINCT FROM b.qa_owner_id
   OR q.linked_test_case_id IS DISTINCT FROM b.linked_test_case_id
   OR q.reopen_count IS DISTINCT FROM b.reopen_count
   OR q.created_by_user_id IS DISTINCT FROM b.created_by;
--> statement-breakpoint

-- Expect 0. Field-level parity for every column that moved to the work item.
SELECT count(*) AS work_item_field_mismatches
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.tickets t ON t.org_id = m.org_id AND t.id = m.work_item_id
WHERE t.title IS DISTINCT FROM b.title
   OR t.description IS DISTINCT FROM b.description
   OR t.assignee_membership_id IS DISTINCT FROM b.assignee_membership_id
   OR t.reporter_id IS DISTINCT FROM b.reporter_id
   OR t.created_at IS DISTINCT FROM (b.created_at AT TIME ZONE 'UTC')
   OR t.updated_at IS DISTINCT FROM (b.updated_at AT TIME ZONE 'UTC')
   OR (b.deleted_at IS NULL) <> (t.deleted_at IS NULL)
   OR t.priority IS DISTINCT FROM (CASE b.priority::text
        WHEN 'low' THEN 'LOW'
        WHEN 'medium' THEN 'MEDIUM'
        WHEN 'high' THEN 'HIGH'
        WHEN 'urgent' THEN 'URGENT'
        ELSE 'MEDIUM'
      END)::public.ticket_priority;
--> statement-breakpoint

-- Expect 0. Every migrated status must name a real state of that project.
SELECT count(*) AS statuses_off_the_project_catalog
FROM build.bug_work_item_map m
JOIN build.tickets t ON t.org_id = m.org_id AND t.id = m.work_item_id
WHERE NOT EXISTS (
  SELECT 1 FROM build.project_statuses ps
  WHERE ps.org_id = t.org_id AND ps.project_id = t.project_id AND ps.name = t.status
);
--> statement-breakpoint

-- Expect 0. No verified or closed defect may land on a started state while the
-- project models a completed state, and no open defect may land on a
-- completed state.
SELECT count(*) AS lifecycle_direction_violations
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.tickets t ON t.org_id = m.org_id AND t.id = m.work_item_id
JOIN build.project_statuses ps
  ON ps.org_id = t.org_id AND ps.project_id = t.project_id AND ps.name = t.status
WHERE (
  b.status IN ('verified', 'closed')
  AND COALESCE(ps.type::text, 'unstarted') <> 'completed'
  AND EXISTS (
    SELECT 1 FROM build.project_statuses c
    WHERE c.org_id = t.org_id AND c.project_id = t.project_id
      AND COALESCE(c.type::text, 'unstarted') = 'completed'
  )
) OR (
  b.status NOT IN ('verified', 'closed')
  AND COALESCE(ps.type::text, 'unstarted') IN ('completed', 'cancelled')
);
--> statement-breakpoint

-- Expect 0. Every non-null bugs.linked_ticket_id must survive as a relation.
SELECT count(*) AS lost_ticket_links
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.tickets lt ON lt.org_id = b.org_id AND lt.id = b.linked_ticket_id
WHERE b.linked_ticket_id IS NOT NULL
  AND b.linked_ticket_id <> m.work_item_id
  AND NOT EXISTS (
    SELECT 1 FROM build.work_item_relations r
    WHERE r.org_id = m.org_id
      AND r.work_item_id = m.work_item_id
      AND r.related_work_item_id = b.linked_ticket_id
  );
--> statement-breakpoint

-- Expect 0. Every test-run evidence pointer must have been re-aimed.
SELECT count(*) AS evidence_pointers_not_migrated
FROM build.test_run_results r
JOIN build.bug_work_item_map m ON m.org_id = r.org_id AND m.bug_id = r.linked_bug_id
WHERE r.linked_bug_id IS NOT NULL
  AND r.linked_work_item_id IS DISTINCT FROM m.work_item_id;
--> statement-breakpoint

-- Expect 0. Every migrated work item must carry a creation activity row.
SELECT count(*) AS work_items_without_creation_activity
FROM build.bug_work_item_map m
WHERE NOT EXISTS (
  SELECT 1 FROM build_events.ticket_activity_log l
  WHERE l.org_id = m.org_id AND l.ticket_id = m.work_item_id AND l.action = 'created'
);
--> statement-breakpoint

-- Expect 0. The map must be a bijection between bugs and work items.
SELECT count(*) AS map_not_bijective
FROM (
  SELECT m.org_id, m.work_item_id
  FROM build.bug_work_item_map m
  GROUP BY m.org_id, m.work_item_id
  HAVING count(*) > 1
) AS collisions;
--> statement-breakpoint

-- Informational. Distribution of the lifecycle mapping actually applied, for
-- the parity report attached to the contraction ticket.
SELECT b.status AS legacy_bug_status, t.status AS canonical_status, count(*) AS rows
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.tickets t ON t.org_id = m.org_id AND t.id = m.work_item_id
GROUP BY b.status, t.status
ORDER BY b.status, t.status;

-- Phase 2 / Workstream B / P0 #7 — QA bug consolidation, BACKFILL phase.
--
-- Requires b-qa-bug-01-expand.sql. Run the whole file inside ONE transaction:
-- statements 2 through 7 are only jointly consistent, and a partial commit
-- would leave canonical work items with no identity-map row.
--
-- Re-run safety. Statement 2 selects only bugs with no build.bug_work_item_map
-- row, so a completed run leaves nothing pending. Statements 3 to 7 are keyed
-- off that map and are individually idempotent (GREATEST, DO NOTHING,
-- IS DISTINCT FROM, NOT EXISTS). Running the file twice is a no-op.
--
-- Order independence. Every per-project ticket number is derived from a single
-- row_number() over a fixed ORDER BY build.bugs.id, and every status decision
-- is derived from array_position over a fixed fallback chain, so the result
-- does not depend on physical row order, on how many batches the run is split
-- into, or on which project is processed first.
--
-- Not a drizzle migration. No migrations/meta/_journal.json entry.

SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO build.project_statuses (org_id, project_id, name, "order", color, type)
SELECT p.org_id, p.id, d.name, d.status_order, d.color, d.state_group::public.state_group
FROM (SELECT DISTINCT b.org_id, b.project_id FROM build.bugs b) AS pending_projects
JOIN build.projects p
  ON p.org_id = pending_projects.org_id AND p.id = pending_projects.project_id
CROSS JOIN (VALUES
  ('TODO', 0, '#e2e8f0', 'unstarted'),
  ('IN_PROGRESS', 1, '#3b82f6', 'started'),
  ('IN_REVIEW', 2, '#eab308', 'started'),
  ('DONE', 3, '#22c55e', 'completed')
) AS d(name, status_order, color, state_group)
WHERE NOT EXISTS (
  SELECT 1 FROM build.project_statuses ps
  WHERE ps.org_id = p.org_id AND ps.project_id = p.id
)
ON CONFLICT ON CONSTRAINT uniq_project_statuses_org_project_name DO NOTHING;
--> statement-breakpoint

WITH pending AS (
  SELECT b.*
  FROM build.bugs b
  JOIN build.projects p ON p.org_id = b.org_id AND p.id = b.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM build.bug_work_item_map m
    WHERE m.org_id = b.org_id AND m.bug_id = b.id
  )
),
status_group AS (
  SELECT * FROM (VALUES
    ('new', 'backlog'),
    ('triaged', 'unstarted'),
    ('assigned', 'unstarted'),
    ('in_progress', 'started'),
    ('fixed', 'started'),
    ('ready_for_qa', 'started'),
    ('verified', 'completed'),
    ('reopened', 'started'),
    ('closed', 'completed')
  ) AS sg(bug_state, target_group)
),
group_chain AS (
  SELECT * FROM (VALUES
    ('backlog',   ARRAY['backlog','unstarted','started','completed','cancelled']),
    ('unstarted', ARRAY['unstarted','backlog','started','completed','cancelled']),
    ('started',   ARRAY['started','unstarted','backlog','completed','cancelled']),
    ('completed', ARRAY['completed','started','unstarted','backlog','cancelled']),
    ('cancelled', ARRAY['cancelled','completed','started','unstarted','backlog'])
  ) AS gc(target_group, groups)
),
base AS (
  SELECT
    d.org_id,
    d.project_id,
    GREATEST(
      COALESCE((
        SELECT c.next_ticket_number FROM build.project_ticket_counters c
        WHERE c.org_id = d.org_id AND c.project_id = d.project_id
      ), 1),
      COALESCE((
        SELECT MAX(t.ticket_number) + 1 FROM build.tickets t
        WHERE t.org_id = d.org_id AND t.project_id = d.project_id
      ), 1)
    ) AS start_number
  FROM (SELECT DISTINCT org_id, project_id FROM pending) AS d
),
planned AS (
  SELECT
    pe.id AS bug_id,
    pe.org_id,
    pe.project_id,
    pe.bug_number,
    pe.title,
    pe.description,
    pe.priority,
    pe.assignee_membership_id,
    pe.reporter_id,
    pe.created_at,
    pe.updated_at,
    pe.deleted_at,
    (bs.start_number
      + row_number() OVER (PARTITION BY pe.org_id, pe.project_id ORDER BY pe.id)
      - 1)::integer AS new_ticket_number,
    st.name AS new_status,
    rm.membership_id AS reporter_membership_id
  FROM pending pe
  JOIN base bs ON bs.org_id = pe.org_id AND bs.project_id = pe.project_id
  LEFT JOIN status_group sg ON sg.bug_state = pe.status::text
  LEFT JOIN group_chain gc ON gc.target_group = COALESCE(sg.target_group, 'backlog')
  LEFT JOIN LATERAL (
    SELECT ps.name
    FROM build.project_statuses ps
    WHERE ps.org_id = pe.org_id AND ps.project_id = pe.project_id
    ORDER BY
      array_position(gc.groups, COALESCE(ps.type::text, 'unstarted')),
      ps."order",
      ps.id
    LIMIT 1
  ) st ON TRUE
  LEFT JOIN LATERAL (
    SELECT om.id AS membership_id
    FROM organization_members om
    WHERE om.org_id = pe.org_id
      AND om.user_id = pe.reporter_id
      AND om.status = 'ACTIVE'
    ORDER BY om.id
    LIMIT 1
  ) rm ON TRUE
),
inserted AS (
  INSERT INTO build.tickets (
    org_id, project_id, ticket_number, title, description, type, status, priority,
    assignee_membership_id, reporter_id, reporter_membership_id, rank,
    created_at, updated_at, deleted_at
  )
  SELECT
    pl.org_id,
    pl.project_id,
    pl.new_ticket_number,
    pl.title,
    pl.description,
    'BUG'::public.ticket_type,
    pl.new_status,
    (CASE pl.priority::text
      WHEN 'low' THEN 'LOW'
      WHEN 'medium' THEN 'MEDIUM'
      WHEN 'high' THEN 'HIGH'
      WHEN 'urgent' THEN 'URGENT'
      ELSE 'MEDIUM'
    END)::public.ticket_priority,
    pl.assignee_membership_id,
    pl.reporter_id,
    pl.reporter_membership_id,
    (1000 + pl.bug_number)::numeric,
    pl.created_at AT TIME ZONE 'UTC',
    pl.updated_at AT TIME ZONE 'UTC',
    CASE WHEN pl.deleted_at IS NULL THEN NULL ELSE pl.deleted_at AT TIME ZONE 'UTC' END
  FROM planned pl
  RETURNING id, org_id, project_id, ticket_number
)
INSERT INTO build.bug_work_item_map (
  org_id, bug_id, project_id, legacy_bug_number, work_item_id, ticket_number
)
SELECT pl.org_id, pl.bug_id, pl.project_id, pl.bug_number, ins.id, ins.ticket_number
FROM planned pl
JOIN inserted ins
  ON ins.org_id = pl.org_id
 AND ins.project_id = pl.project_id
 AND ins.ticket_number = pl.new_ticket_number;
--> statement-breakpoint

INSERT INTO build.project_ticket_counters (org_id, project_id, next_ticket_number)
SELECT m.org_id, m.project_id, MAX(m.ticket_number) + 1
FROM build.bug_work_item_map m
GROUP BY m.org_id, m.project_id
ON CONFLICT ON CONSTRAINT project_ticket_counters_pkey DO UPDATE
  SET next_ticket_number = GREATEST(
        build.project_ticket_counters.next_ticket_number,
        EXCLUDED.next_ticket_number
      ),
      updated_at = now();
--> statement-breakpoint

INSERT INTO build.work_item_qa_details (
  org_id, work_item_id, project_id, qa_state, severity, steps_to_reproduce,
  expected_result, actual_result, environment, browser_device,
  affected_release_id, fixed_release_id, qa_owner_user_id, qa_owner_membership_id,
  linked_test_case_id, reopen_count, created_by_user_id, created_at, updated_at
)
SELECT
  m.org_id,
  m.work_item_id,
  m.project_id,
  b.status,
  b.severity,
  b.steps_to_reproduce,
  b.expected_result,
  b.actual_result,
  b.environment,
  b.browser_device,
  b.affected_release_id,
  b.fixed_release_id,
  b.qa_owner_id,
  COALESCE(b.qa_owner_membership_id, qo.membership_id),
  b.linked_test_case_id,
  b.reopen_count,
  b.created_by,
  b.created_at AT TIME ZONE 'UTC',
  b.updated_at AT TIME ZONE 'UTC'
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
LEFT JOIN LATERAL (
  SELECT om.id AS membership_id
  FROM organization_members om
  WHERE om.org_id = b.org_id
    AND om.user_id = b.qa_owner_id
    AND om.status = 'ACTIVE'
  ORDER BY om.id
  LIMIT 1
) qo ON TRUE
ON CONFLICT ON CONSTRAINT work_item_qa_details_pkey DO NOTHING;
--> statement-breakpoint

INSERT INTO build.work_item_relations (org_id, work_item_id, related_work_item_id, relation_type)
SELECT m.org_id, m.work_item_id, b.linked_ticket_id, 'relates_to'::public.work_item_relation_type
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
JOIN build.tickets t ON t.org_id = b.org_id AND t.id = b.linked_ticket_id
WHERE b.linked_ticket_id IS NOT NULL
  AND b.linked_ticket_id <> m.work_item_id
ON CONFLICT (work_item_id, related_work_item_id) DO NOTHING;
--> statement-breakpoint

UPDATE build.test_run_results r
SET linked_work_item_id = m.work_item_id,
    updated_at = now()
FROM build.bug_work_item_map m
WHERE m.org_id = r.org_id
  AND m.bug_id = r.linked_bug_id
  AND r.linked_bug_id IS NOT NULL
  AND r.linked_work_item_id IS DISTINCT FROM m.work_item_id;
--> statement-breakpoint

INSERT INTO build_events.ticket_activity_log (org_id, ticket_id, user_membership_id, action, created_at)
SELECT
  m.org_id,
  m.work_item_id,
  cm.membership_id,
  'created'::public.ticket_activity_action,
  b.created_at AT TIME ZONE 'UTC'
FROM build.bug_work_item_map m
JOIN build.bugs b ON b.org_id = m.org_id AND b.id = m.bug_id
LEFT JOIN LATERAL (
  SELECT om.id AS membership_id
  FROM organization_members om
  WHERE om.org_id = b.org_id
    AND om.user_id = COALESCE(b.created_by, b.reporter_id)
    AND om.status = 'ACTIVE'
  ORDER BY om.id
  LIMIT 1
) cm ON TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM build_events.ticket_activity_log l
  WHERE l.org_id = m.org_id
    AND l.ticket_id = m.work_item_id
    AND l.action = 'created'
);

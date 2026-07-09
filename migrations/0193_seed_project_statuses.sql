-- Migration 0193: Seed default project_statuses for projects that have none
-- Also copies custom_states rows into project_statuses if not already present
-- Idempotent: uses WHERE NOT EXISTS throughout

INSERT INTO project_statuses (org_id, project_id, name, "order", color, type, created_at, updated_at)
SELECT
  p.org_id,
  p.id AS project_id,
  defaults.name,
  defaults.ord,
  defaults.color,
  defaults.type,
  NOW(),
  NOW()
FROM projects p
CROSS JOIN (VALUES
  ('TODO',        0, '#94a3b8', 'unstarted'),
  ('IN_PROGRESS', 1, '#3b82f6', 'started'),
  ('IN_REVIEW',   2, '#eab308', 'started'),
  ('DONE',        3, '#22c55e', 'completed')
) AS defaults(name, ord, color, type)
WHERE NOT EXISTS (
  SELECT 1
  FROM project_statuses ps
  WHERE ps.project_id = p.id
    AND ps.org_id = p.org_id
);

-- Copy custom_states rows into project_statuses for projects that have custom_states
-- but are missing equivalent project_statuses rows (best-effort, non-destructive)
INSERT INTO project_statuses (org_id, project_id, name, "order", color, type, created_at, updated_at)
SELECT
  cs.org_id,
  cs.project_id,
  cs.name,
  cs.sequence AS "order",
  cs.color,
  CASE cs.group
    WHEN 'backlog'    THEN 'unstarted'
    WHEN 'unstarted'  THEN 'unstarted'
    WHEN 'started'    THEN 'started'
    WHEN 'completed'  THEN 'completed'
    WHEN 'cancelled'  THEN 'cancelled'
    ELSE 'unstarted'
  END AS type,
  cs.created_at,
  NOW()
FROM custom_states cs
WHERE NOT EXISTS (
  SELECT 1
  FROM project_statuses ps
  WHERE ps.project_id = cs.project_id
    AND ps.org_id = cs.org_id
    AND LOWER(ps.name) = LOWER(cs.name)
);

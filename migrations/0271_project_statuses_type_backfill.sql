UPDATE project_statuses
SET type = 'started'
WHERE name IN ('IN_PROGRESS', 'IN_REVIEW')
  AND (type IS NULL OR type = 'unstarted');

UPDATE project_statuses
SET type = 'completed'
WHERE name = 'DONE'
  AND (type IS NULL OR type = 'unstarted');

UPDATE project_statuses
SET type = 'unstarted'
WHERE name = 'TODO'
  AND (type IS NULL OR type = '');

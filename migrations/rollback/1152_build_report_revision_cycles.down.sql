-- Rollback for migration 1152.
--
-- Restores build.bump_report_revision() to the body migration 1073 defined, and removes
-- the report-revision triggers 1152 attached to build.cycles.
--
-- Applying this rollback re-arms the defect 1152 exists to fix: the restored body reads
-- c.sprint_id and joins build.sprints, so it breaks as soon as a-sprint-cycle-04-detach
-- or -05-drop has run. Roll back only on a database where neither has been applied.
--
-- No data is lost. report_revision values are left where they are; they are a cache
-- generation counter, and a higher value is always safe — it costs one report recompute.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP TRIGGER IF EXISTS build_report_revision_insert ON build.cycles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS build_report_revision_update ON build.cycles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS build_report_revision_delete ON build.cycles;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION build.bump_report_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, build, build_events AS $$
DECLARE
  changed text;
  affected text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := 'SELECT * FROM changed_new';
  ELSIF TG_OP = 'DELETE' THEN
    changed := 'SELECT * FROM changed_old';
  ELSE
    changed := 'SELECT * FROM changed_new UNION ALL SELECT * FROM changed_old';
  END IF;

  IF TG_TABLE_NAME = 'sprint_scope_events' THEN
    affected := 'SELECT DISTINCT c.org_id, s.project_id FROM (' || changed || ') c JOIN build.sprints s ON s.org_id = c.org_id AND s.id = c.sprint_id';
  ELSIF TG_TABLE_NAME = 'work_item_relations' THEN
    affected := 'SELECT DISTINCT c.org_id, t.project_id FROM (' || changed || ') c JOIN build.tickets t ON t.org_id = c.org_id AND (t.id = c.work_item_id OR t.id = c.related_work_item_id)';
  ELSE
    affected := 'SELECT DISTINCT org_id, project_id FROM (' || changed || ') c';
  END IF;

  EXECUTE 'WITH affected AS (' || affected || '), locked AS MATERIALIZED (
    SELECT p.org_id, p.id FROM build.projects p JOIN affected a ON a.org_id = p.org_id AND a.project_id = p.id
    ORDER BY p.org_id, p.id FOR UPDATE OF p
  ) UPDATE build.projects p SET report_revision = p.report_revision + 1
    FROM locked l WHERE p.org_id = l.org_id AND p.id = l.id';
  RETURN NULL;
END;
$$;

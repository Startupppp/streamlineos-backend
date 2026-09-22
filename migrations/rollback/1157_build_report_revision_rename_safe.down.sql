-- Rollback for migration 1157.
--
-- Restores the single-name branch that 1152 installed. That body is correct only while
-- build_events.sprint_scope_events still carries its original name.
--
-- Applying this rollback after a-sprint-cycle-06-rename-scope-events.sql has run re-arms the
-- defect 1157 exists to fix: TG_TABLE_NAME reports cycle_scope_events, the branch stops
-- matching, and every scope-event write aborts on 42703. Roll back only on a database where
-- phase 06 has not been applied.
--
-- No data is lost. report_revision values are left where they are; a higher value is always
-- safe, costing one report recompute.

SET lock_timeout = '5s';
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
    affected := 'SELECT DISTINCT c.org_id, y.project_id FROM (' || changed || ') c JOIN build.cycles y ON y.org_id = c.org_id AND y.id = c.cycle_id';
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

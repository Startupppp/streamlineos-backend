SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE build.projects ADD COLUMN report_revision bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION build.bump_report_revision() RETURNS trigger
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
--> statement-breakpoint
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['build.tickets', 'build.project_statuses', 'build.sprints', 'build.work_item_relations', 'build_events.sprint_scope_events'] LOOP
    EXECUTE format('CREATE TRIGGER build_report_revision_insert AFTER INSERT ON %s REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision()', target);
    EXECUTE format('CREATE TRIGGER build_report_revision_update AFTER UPDATE ON %s REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision()', target);
    EXECUTE format('CREATE TRIGGER build_report_revision_delete AFTER DELETE ON %s REFERENCING OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision()', target);
  END LOOP;
END;
$$;
--> statement-breakpoint
RESET lock_timeout;

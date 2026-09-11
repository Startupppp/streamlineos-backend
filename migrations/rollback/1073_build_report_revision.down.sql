SET lock_timeout = '5s';
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['build.tickets', 'build.project_statuses', 'build.sprints', 'build.work_item_relations', 'build_events.sprint_scope_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS build_report_revision_insert ON %s', target);
    EXECUTE format('DROP TRIGGER IF EXISTS build_report_revision_update ON %s', target);
    EXECUTE format('DROP TRIGGER IF EXISTS build_report_revision_delete ON %s', target);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS build.bump_report_revision();
ALTER TABLE build.projects DROP COLUMN report_revision;
RESET lock_timeout;

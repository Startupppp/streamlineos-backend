-- 1152 — repoint build.bump_report_revision() at cycles, before the Sprint/Cycle detach removes what it reads.
-- Rollback: migrations/rollback/1152_build_report_revision_cycles.down.sql
--
-- build.bump_report_revision() is the only invalidation behind all five cached Build
-- reports: the revision it maintains is part of every report cache key. Migration 1073
-- defined it and nothing has replaced it since.
--
-- Its sprint_scope_events branch assembles this statement as TEXT and runs it through
-- EXECUTE:
--
--   'SELECT DISTINCT c.org_id, s.project_id FROM (' || changed || ') c
--      JOIN build.sprints s ON s.org_id = c.org_id AND s.id = c.sprint_id'
--
-- Two of those references are removed by migrations already staged in migrations/sql:
--   a-sprint-cycle-04-detach.sql  drops build_events.sprint_scope_events.sprint_id
--   a-sprint-cycle-05-drop.sql    drops build.sprints
--
-- Because the reference lives inside a string, PostgreSQL records no dependency and both
-- DROPs succeed silently. The failure surfaces later as 42703 raised inside an
-- AFTER ... FOR EACH STATEMENT trigger, which aborts the writing transaction — so every
-- write that records a sprint-scope event fails: adding or removing a ticket from a
-- cycle, an estimate change, a completion, a reopen. The detach migration's own guard is
-- a data check over build.tickets.sprint_id and cannot see a trigger body.
--
-- The ORM already moved: src/db/schema/build/sprint-events.ts declares cycle_id with
-- fk_sprint_scope_events_org_cycle. This migration moves the trigger to match, and must
-- be applied BEFORE a-sprint-cycle-04-detach.sql.
--
-- It also attaches the triggers to build.cycles, which 1073 never covered. Burnup reads
-- a cycle's start and end dates and velocity reads its status, so editing a cycle changes
-- both reports; without this the edit bumps no revision and the stale entry serves out its
-- TTL. build.cycles carries org_id and project_id directly, so it needs no join branch.
--
-- The build.sprints triggers are left in place. They are harmless while the table exists
-- and are dropped with it by a-sprint-cycle-05-drop.sql.
--
-- No CONCURRENTLY and no index work here; drizzle-kit migrate wraps this file in one
-- transaction. Precedent 1108.

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
--> statement-breakpoint

DROP TRIGGER IF EXISTS build_report_revision_insert ON build.cycles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS build_report_revision_update ON build.cycles;
--> statement-breakpoint
DROP TRIGGER IF EXISTS build_report_revision_delete ON build.cycles;
--> statement-breakpoint

CREATE TRIGGER build_report_revision_insert AFTER INSERT ON build.cycles
  REFERENCING NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision();
--> statement-breakpoint
CREATE TRIGGER build_report_revision_update AFTER UPDATE ON build.cycles
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
  FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision();
--> statement-breakpoint
CREATE TRIGGER build_report_revision_delete AFTER DELETE ON build.cycles
  REFERENCING OLD TABLE AS changed_old
  FOR EACH STATEMENT EXECUTE FUNCTION build.bump_report_revision();
--> statement-breakpoint

DO $$
DECLARE
  body text;
  cycle_triggers integer;
BEGIN
  SELECT prosrc INTO body FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'build' AND p.proname = 'bump_report_revision';
  IF body IS NULL THEN
    RAISE EXCEPTION '1152: build.bump_report_revision() is absent after replacement';
  END IF;
  IF body LIKE '%c.sprint_id%' THEN
    RAISE EXCEPTION '1152: the function still reads c.sprint_id, which a-sprint-cycle-04-detach drops';
  END IF;
  IF body LIKE '%build.sprints%' THEN
    RAISE EXCEPTION '1152: the function still joins build.sprints, which a-sprint-cycle-05-drop drops';
  END IF;
  IF body NOT LIKE '%c.cycle_id%' OR body NOT LIKE '%build.cycles%' THEN
    RAISE EXCEPTION '1152: the sprint_scope_events branch was not repointed at build.cycles';
  END IF;

  SELECT count(*) INTO cycle_triggers
    FROM pg_trigger
   WHERE tgrelid = 'build.cycles'::regclass
     AND NOT tgisinternal
     AND tgname IN ('build_report_revision_insert', 'build_report_revision_update', 'build_report_revision_delete');
  IF cycle_triggers <> 3 THEN
    RAISE EXCEPTION '1152: build.cycles carries % of 3 report-revision triggers', cycle_triggers;
  END IF;
END
$$;

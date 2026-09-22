-- 1157 — make build.bump_report_revision() survive the phase 06 scope-events rename.
-- Rollback: migrations/rollback/1157_build_report_revision_rename_safe.down.sql
--
-- a-sprint-cycle-06-rename-scope-events.sql renames build_events.sprint_scope_events to
-- cycle_scope_events. TG_TABLE_NAME reports the table's name at the moment the trigger fires,
-- so after that rename the branch
--
--   IF TG_TABLE_NAME = 'sprint_scope_events' THEN ...
--
-- stops matching and control falls through to the ELSE arm, which is
--
--   'SELECT DISTINCT org_id, project_id FROM (' || changed || ') c'
--
-- That table has no project_id column -- it carries org_id, cycle_id and ticket_id -- so the
-- fall-through raises 42703 column "project_id" does not exist, inside an AFTER ... FOR EACH
-- STATEMENT trigger, which aborts the writing transaction. Every write that records a scope
-- event fails: adding or removing a ticket from a cycle, an estimate change, a completion, a
-- reopen.
--
-- This is the same failure 1152 fixed, re-created by a different mechanism. 1152 fixed a
-- reference that a DROP removed; this fixes a branch predicate that a RENAME stops matching.
-- Neither is visible to PostgreSQL's dependency tracking, because both live inside strings.
--
-- The fix matches both names. That is deliberately rename-order-independent: it is correct
-- before phase 06, after phase 06, and after a phase 06 rollback, so it needs no lockstep with
-- the deploy that renames the table. The phase 06 header already names one precondition -- that
-- the Drizzle declaration must change in the same step -- and did not know about this trigger.
--
-- No CONCURRENTLY and no index work; drizzle-kit migrate wraps this file in one transaction.

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

  IF TG_TABLE_NAME IN ('sprint_scope_events', 'cycle_scope_events') THEN
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

DO $$
DECLARE
  body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'build' AND p.proname = 'bump_report_revision';
  IF body IS NULL THEN
    RAISE EXCEPTION '1157: build.bump_report_revision() is absent after replacement';
  END IF;
  IF body NOT LIKE '%cycle_scope_events%' THEN
    RAISE EXCEPTION '1157: the branch does not match the renamed table, so phase 06 would break it';
  END IF;
  IF body NOT LIKE '%sprint_scope_events%' THEN
    RAISE EXCEPTION '1157: the branch no longer matches the pre-rename table, so it breaks before phase 06';
  END IF;
  IF body LIKE '%c.sprint_id%' OR body LIKE '%build.sprints%' THEN
    RAISE EXCEPTION '1157: the 1152 fix was lost -- the body reads sprint_id or joins build.sprints';
  END IF;
END
$$;

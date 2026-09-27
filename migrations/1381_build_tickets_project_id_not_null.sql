-- 1381 — Build: Make tickets.project_id NOT NULL
--
-- The composite FK fk_tickets_status references project_statuses on
-- (org_id, project_id, status).  PostgreSQL MATCH SIMPLE (the default) does
-- not check the FK when any referencing column is NULL.  Because project_id is
-- nullable, a project-less ticket can carry any status string, bypassing the
-- constraint entirely.  The same null behaviour in the unique index
-- uniq_tickets_project_number (now partial, per migration 1380) means two
-- project-less tickets with the same ticket_number do not collide, because
-- NULL != NULL in index semantics.
--
-- Making project_id NOT NULL closes both holes simultaneously:
--  • MATCH SIMPLE always checks the FK when all referencing columns are non-null.
--  • The uniqueness index covers all surviving rows (project_id can no longer
--    be NULL, so the NULL != NULL escape is eliminated).
--
-- PREREQUISITE — orchestrator must run and evaluate before applying:
--
--   SELECT count(*) FROM build.tickets WHERE project_id IS NULL AND deleted_at IS NULL;
--
-- Decision tree:
--   count = 0  — apply this migration as written.  VALIDATE CONSTRAINT will
--                succeed, SET NOT NULL will be instantaneous (the CHECK proves
--                no nulls), and the FK becomes always-enforced.
--
--   count > 0  — VALIDATE will fail.  Application must first assign or delete
--                all project-less active tickets.  As an interim, you may run
--                only the ADD CONSTRAINT NOT VALID step (skip VALIDATE and SET
--                NOT NULL) to express intent without a blocking scan; re-run
--                the full migration once the rows are clear.
--
-- Re migration 0371 check constraint
-- 0371 deliberately excluded tickets.status, citing trust in the FK.  That
-- trust was misplaced due to the null hole documented here.  After this
-- migration the FK is always enforced.  A static CHECK over status values
-- remains correctly excluded: project_statuses defines the valid set per
-- project and that set is user-controlled, so no finite fixed list can
-- enumerate it.  The FK is the right mechanism; this migration makes it work.

SET lock_timeout = '5s';
SET statement_timeout = 0;
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1381 precondition: build.tickets is absent';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tickets_project_id_not_null'
      AND conrelid = 'build.tickets'::regclass
  ) THEN
    ALTER TABLE build.tickets
      ADD CONSTRAINT chk_tickets_project_id_not_null
      CHECK (project_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build.tickets VALIDATE CONSTRAINT chk_tickets_project_id_not_null;
--> statement-breakpoint

ALTER TABLE build.tickets ALTER COLUMN project_id SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tickets_project_id_not_null'
      AND conrelid = 'build.tickets'::regclass
  ) THEN
    ALTER TABLE build.tickets DROP CONSTRAINT chk_tickets_project_id_not_null;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT (
    SELECT attnotnull
    FROM pg_attribute
    WHERE attrelid = 'build.tickets'::regclass
      AND attname = 'project_id'
      AND attnum > 0
  ), '1381 post-check: project_id is still nullable';
END $$;

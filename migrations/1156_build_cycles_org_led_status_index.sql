-- 1156 — replace the project-led cycles status index with an org-led one.
-- Rollback: migrations/rollback/1156_build_cycles_org_led_status_index.down.sql
--
-- a-sprint-cycle-03-constrain.sql created idx_cycles_project_status_live as
-- (project_id, status) WHERE deleted_at IS NULL. 1155 journalled it verbatim rather than
-- improving it, so that an already-migrated database and a cold build would agree. This
-- migration makes the correction once, in one place, for both.
--
-- Two rules. BE-44: lead composite indexes with org_id, then the filter columns. BE-79: the
-- RLS policy qual is not leakproof, so org_id must be inside the covering index or the planner
-- cannot answer it from the index and heap-fetches each candidate row to evaluate
-- app.current_org_id().
--
-- listCycles (cycles.service.ts:15) filters org_id, project_id, an optional status, and now
-- deleted_at IS NULL, ordering by start_date. (org_id, project_id, status) matches that
-- prefix-for-prefix; (project_id, status) could not answer the tenant predicate at all.
--
-- The old index is dropped rather than left alongside: it is a strict prefix-subset of the new
-- one for every query that also supplies org_id, and keeping both taxes every write to
-- build.cycles for no additional read.
--
-- NOT MEASURED. No query plan was captured -- the audit that produced this had no database
-- access. Cycle counts per project are modest, so the expected gain is bounded. Verify with
-- EXPLAIN (ANALYZE, BUFFERS) as streamline_app with the tenant GUC set (BE-76), comparing
-- buffers rather than milliseconds (BE-77), before claiming an improvement.
--
-- No CONCURRENTLY; drizzle-kit migrate wraps this file in one transaction. Precedent 1108.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_org_project_status_live"
  ON "build"."cycles" ("org_id", "project_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_cycles_project_status_live";
--> statement-breakpoint

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_cycles_org_project_status_live'
     AND x.indrelid = 'build.cycles'::regclass;
  IF definition IS NULL THEN
    RAISE EXCEPTION '1156: idx_cycles_org_project_status_live was not created';
  END IF;
  IF definition NOT LIKE '%org_id, project_id, status%' THEN
    RAISE EXCEPTION '1156: wrong column order, the tenant predicate is not led (%)', definition;
  END IF;
  IF definition NOT LIKE '%deleted_at IS NULL%' THEN
    RAISE EXCEPTION '1156: the partial predicate does not match the cycle reads (%)', definition;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_cycles_project_status_live' AND n.nspname = 'build'
  ) THEN
    RAISE EXCEPTION '1156: the superseded project-led index is still present';
  END IF;
END
$$;

-- 1155 — journal the cycle columns and indexes the Sprint/Cycle cutover created outside the journal.
-- Rollback: migrations/rollback/1155_build_cycles_drift_reconcile.down.sql
--
-- a-sprint-cycle-01-expand.sql and -03-constrain.sql live in migrations/sql, which is not
-- journalled. They added two columns and four indexes that src/db/schema/build never picked
-- up, so three things are true at once:
--
--   1. A database built from the journal alone -- a cold replay, the disposable stack,
--      check:migration-chain -- has none of these indexes. Benchmarks taken there under-report,
--      and the velocity keyset has no supporting index at all.
--   2. check:tenant-indexes fails on build_events.sprint_scope_events, because the gate reads
--      the schema files and the only index declared there is on ticket_id. It is one of two
--      failures across 924 tenant tables, so a real missing index would be lost beside it.
--   3. build.cycles.deleted_at exists in a migrated database and is unrepresentable in the ORM,
--      so no read can filter it and the partial indexes below cannot be proven applicable.
--
-- Every statement is IF NOT EXISTS: on a database where phases 01 and 03 already ran this is a
-- no-op, and on a cold build it creates what the schema now declares. The Drizzle schema is
-- updated in the same change, so the two stop drifting apart.
--
-- The index definitions are copied verbatim from the phase files rather than improved, so that
-- an already-migrated database and a cold build end up byte-identical. In particular
-- idx_cycles_project_status_live leads with project_id rather than org_id; that is what phase 03
-- created, and changing it here would make the two diverge. It is recorded in the follow-up as
-- open rather than silently rewritten.
--
-- build.cycles.deleted_at is never written today: deleteCycle (cycles.service.ts:133) is a hard
-- delete. Adding the column to the model and the predicate to the reads is therefore inert on
-- current data and exists to make the partial indexes usable.
--
-- No CONCURRENTLY; drizzle-kit migrate wraps this file in one transaction. Precedent 1108.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "goal" text;
--> statement-breakpoint
ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_project_status_live"
  ON "build"."cycles" ("project_id", "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_org_project_velocity_cursor"
  ON "build"."cycles" ("org_id", "project_id", "start_date" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL AND "status" IN ('active', 'completed');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_cycle_live"
  ON "build"."tickets" ("org_id", "cycle_id")
  WHERE "deleted_at" IS NULL AND "cycle_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sprint_scope_events_org_cycle_created"
  ON "build_events"."sprint_scope_events" ("org_id", "cycle_id", "created_at");
--> statement-breakpoint

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected.name, ', ') INTO missing
    FROM (VALUES
      ('idx_cycles_project_status_live'),
      ('idx_cycles_org_project_velocity_cursor'),
      ('idx_tickets_org_cycle_live'),
      ('idx_sprint_scope_events_org_cycle_created')
    ) AS expected(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = expected.name
       AND c.relkind = 'i'
       AND n.nspname IN ('build', 'build_events')
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '1155: index(es) absent after reconcile: %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'deleted_at'
  ) THEN
    RAISE EXCEPTION '1155: build.cycles.deleted_at is absent, so the partial indexes cannot be used';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'goal'
  ) THEN
    RAISE EXCEPTION '1155: build.cycles.goal is absent';
  END IF;
END
$$;

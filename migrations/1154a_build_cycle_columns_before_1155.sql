-- 1154a — give a cold build the cycle columns 1155 indexes, before 1155 runs.
--
-- 1155 builds indexes on cycle_id and on build.cycles.deleted_at. On a database that ran the
-- off-journal sprint/cycle cutover (production) those columns already exist. On a cold build
-- they are created by 1396_build_sprint_cycle_chain_repair, which sits ~100 entries LATER in
-- the journal, so a strict in-order replay (migration:proof) died at
--   1155 stmt 7/8: 42703 column "cycle_id" does not exist
-- and db:bootstrap only reached head by deferring 1155/1156/1197/1371 until after 1396.
--
-- This runs the column half of 1396 early: the same guarded sprint_id -> cycle_id rename loop
-- and the same three ADD COLUMN IF NOT EXISTS, verbatim, so the result is identical to what
-- 1396 produces. 1396 itself is untouched and still applies after it; every statement there is
-- guarded, so it finds the columns present and goes on to create the archive tables.
--
-- On any database where the columns already exist (production, every migrated cell) each
-- statement is a no-op. 1396 cannot simply move: restamping its `when` would orphan its ledger
-- row (check-migration-discipline forbids it), and an identical copy would be skipped by hash
-- and leave 1396's `when` unrecorded.
--
-- It also seeds build:sprints:view / build:sprints:manage, with 1396's own guarded block.
-- 1197_build_cycle_permissions renames those two rows to build:cycles:* and its precondition
-- raises when they are absent, which on a cold build they were until 1396 ran:
--   1197 precondition: legacy Build iteration permissions are missing
-- The block returns at once wherever build:cycles:* already exist (production, every database
-- 1197 has run on), so there it inserts nothing.
--
-- No CONCURRENTLY; this runs in one transaction.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  rec record;
BEGIN
  IF to_regclass('build.cycles') IS NULL THEN
    RETURN;
  END IF;

  FOR rec IN
    SELECT 'build' AS sch, 'project_meetings' AS tbl
    UNION ALL SELECT 'build', 'test_runs'
    UNION ALL SELECT 'build', 'tickets'
    UNION ALL SELECT 'build_events', 'cycle_scope_events'
    UNION ALL SELECT 'build_events', 'sprint_scope_events'
  LOOP
    IF to_regclass(rec.sch || '.' || rec.tbl) IS NULL THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = rec.sch AND table_name = rec.tbl AND column_name = 'sprint_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = rec.sch AND table_name = rec.tbl AND column_name = 'cycle_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I RENAME COLUMN sprint_id TO cycle_id', rec.sch, rec.tbl);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "legacy_sprint_id" integer;
--> statement-breakpoint
ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "goal" text;
--> statement-breakpoint
ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint

DO $$
DECLARE
  admin_key text := NULL;
BEGIN
  IF EXISTS (SELECT 1 FROM permissions WHERE name IN ('build:cycles:view', 'build:cycles:manage')) THEN
    RETURN;
  END IF;

  IF to_regclass('public.modules_catalog') IS NOT NULL
     AND EXISTS (SELECT 1 FROM modules_catalog WHERE module_key = 'build') THEN
    admin_key := 'build';
  END IF;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, is_delegable)
  VALUES
    ('build:sprints:view', 'build:sprints', 'view', 'View iterations', 'build', admin_key, true),
    ('build:sprints:manage', 'build:sprints', 'manage', 'Manage iterations', 'build', admin_key, true)
  ON CONFLICT (name) DO NOTHING;
END $$;

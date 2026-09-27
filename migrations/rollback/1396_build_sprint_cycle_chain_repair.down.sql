SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  rec record;
  report text := '';
  total bigint := 0;
BEGIN
  FOR rec IN
    SELECT 'sprints_archive' AS tbl
    UNION ALL SELECT 'sprint_binding_archive'
    UNION ALL SELECT 'sprint_cycle_migration_map'
  LOOP
    IF to_regclass('build.' || rec.tbl) IS NOT NULL THEN
      DECLARE
        n bigint;
      BEGIN
        EXECUTE format('SELECT count(*) FROM build.%I', rec.tbl) INTO n;
        total := total + n;
        IF n > 0 THEN
          report := report || format('build.%s has %s row(s) | ', rec.tbl, n);
        END IF;
      END;
    END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE EXCEPTION '1396-rollback refuses to drop the sprint-to-cycle archive tables because they still hold the only record of the migration: %', report;
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."sprint_cycle_migration_map";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."sprint_binding_archive";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."sprints_archive";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM build.cycles WHERE legacy_sprint_id IS NOT NULL) THEN
    RAISE EXCEPTION '1396-rollback refuses to drop build.cycles.legacy_sprint_id while % row(s) still carry a legacy sprint reference',
      (SELECT count(*) FROM build.cycles WHERE legacy_sprint_id IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "legacy_sprint_id";
--> statement-breakpoint

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT 'build' AS sch, 'project_meetings' AS tbl
    UNION ALL SELECT 'build', 'test_runs'
    UNION ALL SELECT 'build_events', 'cycle_scope_events'
  LOOP
    IF to_regclass(rec.sch || '.' || rec.tbl) IS NULL THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = rec.sch AND table_name = rec.tbl AND column_name = 'cycle_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = rec.sch AND table_name = rec.tbl AND column_name = 'sprint_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I.%I RENAME COLUMN cycle_id TO sprint_id', rec.sch, rec.tbl);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

DELETE FROM permissions WHERE name IN ('build:sprints:view', 'build:sprints:manage');

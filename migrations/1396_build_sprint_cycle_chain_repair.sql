SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.cycles') IS NULL THEN
    RAISE EXCEPTION '1396 precondition: build.cycles is absent - this is not a Build database';
  END IF;
END $$;
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

CREATE TABLE IF NOT EXISTS "build"."sprints_archive" (
  "id" integer NOT NULL,
  "org_id" text NOT NULL,
  "project_id" integer NOT NULL,
  "name" text NOT NULL,
  "start_date" timestamp NOT NULL,
  "end_date" timestamp NOT NULL,
  "goal" text,
  "status" text NOT NULL DEFAULT 'PLANNED',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprint_binding_archive" (
  "org_id" text NOT NULL,
  "source_table" text NOT NULL,
  "source_id" bigint NOT NULL,
  "sprint_id" integer NOT NULL,
  "cycle_id" integer,
  "resolution" text NOT NULL,
  CONSTRAINT "pk_sprint_binding_archive" PRIMARY KEY ("source_table", "org_id", "source_id"),
  CONSTRAINT "chk_sprint_binding_archive_resolution" CHECK ("resolution" = ANY (ARRAY['mapped'::text, 'agreed'::text, 'cycle_wins'::text, 'orphan_sprint'::text]))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "build"."sprint_cycle_migration_map" (
  "org_id" text NOT NULL,
  "sprint_id" integer NOT NULL,
  "cycle_id" integer NOT NULL,
  "mapped_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pk_sprint_cycle_migration_map" PRIMARY KEY ("org_id", "sprint_id"),
  CONSTRAINT "uniq_sprint_cycle_migration_map_cycle" UNIQUE ("org_id", "cycle_id")
);
--> statement-breakpoint

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['sprints_archive', 'sprint_binding_archive', 'sprint_cycle_migration_map']
  LOOP
    EXECUTE format('ALTER TABLE build.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON build.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON build.%I USING ("org_id" = app.current_org_id()) WITH CHECK ("org_id" = app.current_org_id())',
      tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON build.%I TO streamline_app', tbl);
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  seeded integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM permissions WHERE name = 'build:cycles:view') THEN
    RETURN;
  END IF;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:sprints:view', 'build:sprints', 'view', 'View iterations', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE name = 'build:tickets:view'
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:sprints:manage', 'build:sprints', 'manage', 'Manage iterations', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE name = 'build:tickets:update'
  ON CONFLICT (name) DO NOTHING;

  SELECT count(*) INTO seeded FROM permissions WHERE name IN ('build:sprints:view', 'build:sprints:manage');
  IF seeded <> 2 THEN
    RAISE EXCEPTION '1396 could not seed the legacy iteration permissions 1197 renames: found % of 2, and build:tickets:view/update must exist first', seeded;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='build' AND table_name='cycles' AND column_name='legacy_sprint_id')
    THEN missing := missing || 'build.cycles.legacy_sprint_id '; END IF;
  IF to_regclass('build.sprints_archive') IS NULL THEN missing := missing || 'build.sprints_archive '; END IF;
  IF to_regclass('build.sprint_binding_archive') IS NULL THEN missing := missing || 'build.sprint_binding_archive '; END IF;
  IF to_regclass('build.sprint_cycle_migration_map') IS NULL THEN missing := missing || 'build.sprint_cycle_migration_map '; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='build' AND table_name='test_runs' AND column_name='sprint_id')
    THEN missing := missing || 'build.test_runs.sprint_id-not-renamed '; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '1396 postcondition failed, still absent or unrenamed: %', missing;
  END IF;
END $$;

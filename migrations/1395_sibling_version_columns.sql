SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.cycles') IS NULL THEN
    RAISE EXCEPTION '1395 precondition: build.cycles is absent';
  END IF;
  IF to_regclass('build.project_milestones') IS NULL THEN
    RAISE EXCEPTION '1395 precondition: build.project_milestones is absent';
  END IF;
  IF to_regclass('build.modules') IS NULL THEN
    RAISE EXCEPTION '1395 precondition: build.modules is absent';
  END IF;
  IF to_regclass('build.roadmap_items') IS NULL THEN
    RAISE EXCEPTION '1395 precondition: build.roadmap_items is absent';
  END IF;
  IF to_regclass('build.project_releases') IS NULL THEN
    RAISE EXCEPTION '1395 precondition: build.project_releases is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."cycles"             ADD COLUMN "version"     integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_milestones" ADD COLUMN "version"     integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."modules"            ADD COLUMN "version"     integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."roadmap_items"      ADD COLUMN "version"     integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "build"."project_releases"   ADD COLUMN "row_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION build.bump_sibling_version()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION build.bump_release_row_version()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER trg_cycles_version_bump
  BEFORE UPDATE ON "build"."cycles"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

CREATE TRIGGER trg_project_milestones_version_bump
  BEFORE UPDATE ON "build"."project_milestones"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

CREATE TRIGGER trg_modules_version_bump
  BEFORE UPDATE ON "build"."modules"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

CREATE TRIGGER trg_roadmap_items_version_bump
  BEFORE UPDATE ON "build"."roadmap_items"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_sibling_version();
--> statement-breakpoint

CREATE TRIGGER trg_project_releases_row_version_bump
  BEFORE UPDATE ON "build"."project_releases"
  FOR EACH ROW
  EXECUTE FUNCTION build.bump_release_row_version();
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'version'
  ), '1395 post-check: version column was not created on build.cycles';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_milestones' AND column_name = 'version'
  ), '1395 post-check: version column was not created on build.project_milestones';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'modules' AND column_name = 'version'
  ), '1395 post-check: version column was not created on build.modules';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'roadmap_items' AND column_name = 'version'
  ), '1395 post-check: version column was not created on build.roadmap_items';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'project_releases' AND column_name = 'row_version'
  ), '1395 post-check: row_version column was not created on build.project_releases';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_cycles_version_bump'
      AND tgrelid = 'build.cycles'::regclass
  ), '1395 post-check: trg_cycles_version_bump was not created on build.cycles';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_project_milestones_version_bump'
      AND tgrelid = 'build.project_milestones'::regclass
  ), '1395 post-check: trg_project_milestones_version_bump was not created on build.project_milestones';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_modules_version_bump'
      AND tgrelid = 'build.modules'::regclass
  ), '1395 post-check: trg_modules_version_bump was not created on build.modules';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_roadmap_items_version_bump'
      AND tgrelid = 'build.roadmap_items'::regclass
  ), '1395 post-check: trg_roadmap_items_version_bump was not created on build.roadmap_items';

  ASSERT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_project_releases_row_version_bump'
      AND tgrelid = 'build.project_releases'::regclass
  ), '1395 post-check: trg_project_releases_row_version_bump was not created on build.project_releases';
END $$;

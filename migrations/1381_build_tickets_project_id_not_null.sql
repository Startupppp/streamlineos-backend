SET lock_timeout = '5s';
SET statement_timeout = 0;
--> statement-breakpoint

DO $$
DECLARE
  null_count bigint;
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1381 precondition: build.tickets is absent';
  END IF;
  SELECT count(*) INTO null_count FROM build.tickets WHERE project_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION '1381 precondition: % row(s) with project_id IS NULL (including soft-deleted rows); all must be resolved before applying NOT NULL', null_count;
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

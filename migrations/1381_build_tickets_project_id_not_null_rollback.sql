SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'build.tickets'::regclass
      AND attname = 'project_id'
      AND attnotnull = true
      AND attnum > 0
  ) THEN
    RAISE EXCEPTION '1381-rollback precondition: project_id is already nullable — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE build.tickets ALTER COLUMN project_id DROP NOT NULL;

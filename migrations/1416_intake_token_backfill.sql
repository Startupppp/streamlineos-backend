SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects' AND column_name = 'intake_token'
  ) THEN
    RAISE EXCEPTION '1416 precondition: intake_token column does not exist on build.projects — run 1415 first';
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  batch_size int := 500;
  rows_updated int;
BEGIN
  LOOP
    UPDATE "build"."projects"
    SET intake_token = encode(gen_random_bytes(24), 'hex')
    WHERE id IN (
      SELECT id FROM "build"."projects"
      WHERE intake_token IS NULL
      LIMIT batch_size
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM "build"."projects" WHERE intake_token IS NULL LIMIT 1
  ), '1416 post-check: build.projects still has rows with intake_token IS NULL after backfill';
END $$;

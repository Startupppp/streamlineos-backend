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
  IF to_regprocedure('public.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION '1416 precondition: pgcrypto gen_random_bytes() is unavailable — CREATE EXTENSION pgcrypto before this migration';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."projects"
  ALTER COLUMN "intake_token" SET DEFAULT encode(gen_random_bytes(24), 'hex');
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
DECLARE
  null_rows bigint;
  distinct_tokens bigint;
  total_rows bigint;
BEGIN
  SELECT count(*) INTO null_rows FROM "build"."projects" WHERE intake_token IS NULL;
  ASSERT null_rows = 0,
    format('1416 post-check: build.projects still has %s rows with intake_token IS NULL after backfill', null_rows);

  SELECT count(*), count(DISTINCT intake_token) INTO total_rows, distinct_tokens
  FROM "build"."projects";
  ASSERT total_rows = distinct_tokens,
    format('1416 post-check: intake_token is not unique across build.projects — %s rows but %s distinct tokens', total_rows, distinct_tokens);

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'projects'
      AND column_name = 'intake_token' AND column_default IS NOT NULL
  ), '1416 post-check: intake_token has no column default, so a future insert omitting it would write NULL';
END $$;

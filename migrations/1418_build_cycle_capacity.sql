SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.cycles') IS NULL THEN
    RAISE EXCEPTION '1418 precondition: build.cycles is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."cycles" ADD COLUMN IF NOT EXISTS "capacity" integer;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ), '1418 post-check: build.cycles.capacity was not added';

  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ) = 'YES', '1418 post-check: capacity must stay nullable — existing cycles have no known capacity';
END $$;

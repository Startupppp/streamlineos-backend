SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ) THEN
    RAISE EXCEPTION '1418-rollback precondition: build.cycles.capacity does not exist — nothing to roll back';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."cycles" DROP COLUMN IF EXISTS "capacity";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'cycles' AND column_name = 'capacity'
  ), '1418-rollback post-check: build.cycles.capacity still exists';
END $$;

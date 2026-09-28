SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'story_points'
  ) THEN
    RAISE EXCEPTION '1420-rollback precondition: build.tickets.story_points is absent, so the values 1420 copied forward cannot be proven to still exist and clearing points would lose them';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "build"."tickets"
SET "points" = NULL
WHERE "story_points" IS NOT NULL AND "points" = "story_points";
--> statement-breakpoint

DO $$
DECLARE
  surviving bigint;
BEGIN
  SELECT count(*) INTO surviving
  FROM "build"."tickets"
  WHERE "story_points" IS NOT NULL AND "points" IS NOT NULL AND "points" = "story_points";
  ASSERT surviving = 0,
    format('1420-rollback post-check: %s tickets still carry the backfilled copy on points', surviving);
END $$;

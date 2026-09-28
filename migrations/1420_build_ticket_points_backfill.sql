SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1420 precondition: build.tickets is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'points'
  ) THEN
    RAISE EXCEPTION '1420 precondition: build.tickets.points is absent — points is the column the ticket write path and every report now use';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'build' AND table_name = 'tickets' AND column_name = 'story_points'
  ) THEN
    RAISE EXCEPTION '1420 precondition: build.tickets.story_points is absent — this backfill is the only path that carries legacy story_points values onto points, so a contraction that drops the column must supersede this migration rather than replay past it';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "build"."tickets"
SET "points" = "story_points"
WHERE "points" IS NULL AND "story_points" IS NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  stranded bigint;
BEGIN
  SELECT count(*) INTO stranded
  FROM "build"."tickets"
  WHERE "points" IS NULL AND "story_points" IS NOT NULL;
  ASSERT stranded = 0,
    format('1420 post-check: %s tickets still hold a story_points value that no report or UI surface reads', stranded);
END $$;

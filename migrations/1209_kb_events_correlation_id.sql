-- 1209 — Knowledge base: `correlation_id` on `kb_events`
--
-- Adds a nullable `correlation_id` column to `kb_events` so every event emitted for one Ask
-- can be joined back to its `kb_ai_interactions` row via the shared UUID. Without this column,
-- the event record and the interaction record are forever disconnected.
--
-- The column is nullable because all pre-existing events and all non-Ask events (view, search,
-- helpful_vote, etc.) have no interaction to link to. The index is partial to keep it compact:
-- only rows that carry a value need to be indexed.
--
-- Rollback: migrations/rollback/1209_kb_events_correlation_id.down.sql
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_events') IS NULL THEN
    RAISE EXCEPTION '1209 precondition: public.kb_events is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "public"."kb_events"
  ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_events_org_correlation"
  ON "public"."kb_events" ("org_id", "correlation_id")
  WHERE "correlation_id" IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'kb_events'
      AND column_name = 'correlation_id'
  ) THEN
    RAISE EXCEPTION '1209 postcondition: correlation_id column is absent on kb_events';
  END IF;
END $$;
--> statement-breakpoint

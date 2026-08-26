-- 0508_calendar_event_exceptions
-- Stores per-occurrence overrides and cancellations for recurring calendar
-- events.  The primary key of a logical occurrence is (org_id, event_id,
-- occurrence_start) — the UTC instant that the rrule engine produced for that
-- slot before any modification.
--
-- RLS: follows the tenant-isolation pattern used across this codebase.
-- calendar_events itself has no RLS yet, but this table is a child of it and
-- holds potentially private meeting modifications, so it must be isolated here.

SET lock_timeout = '5s';

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_exceptions" (
  "id"               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id"           text NOT NULL
                       REFERENCES "organizations"("id") ON DELETE CASCADE,
  "event_id"         integer NOT NULL
                       REFERENCES "calendar_events"("id") ON DELETE CASCADE,
  "occurrence_start" timestamp with time zone NOT NULL,
  "is_cancelled"     boolean NOT NULL DEFAULT FALSE,
  "modified_title"   text,
  "modified_start"   timestamp with time zone,
  "modified_end"     timestamp with time zone,
  "created_at"       timestamp with time zone DEFAULT NOW() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT NOW() NOT NULL
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_cal_exc_org_event_occ"
  ON "calendar_event_exceptions" ("org_id", "event_id", "occurrence_start");

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cal_exc_org_event"
  ON "calendar_event_exceptions" ("org_id", "event_id");

--> statement-breakpoint
ALTER TABLE "calendar_event_exceptions" ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "calendar_event_exceptions";

--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendar_event_exceptions"
  USING ("org_id" = app.current_org_id())
  WITH CHECK ("org_id" = app.current_org_id());

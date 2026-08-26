-- 0507_calendar_recurrence_columns
-- Re-introduces recurrence on calendar_events now that the rrule package
-- is approved.  Two columns:
--   rrule         — a bare RFC 5545 RRULE property value (no DTSTART prefix),
--                   e.g. "FREQ=WEEKLY;BYDAY=MO;COUNT=26".  NULL means the event
--                   is a single non-recurring occurrence.
--   recurrence_end — the inclusive UTC end of the series; used when querying the
--                   DB to find recurring series that overlap a given window, so
--                   we don't fetch every series for every query.  NULL means the
--                   series never ends (COUNT=N or UNTIL is encoded in rrule).

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "calendar_events"
  ADD COLUMN "rrule" text,
  ADD COLUMN "recurrence_end" timestamp with time zone;

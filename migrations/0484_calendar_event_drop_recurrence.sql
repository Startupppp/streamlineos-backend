-- 0484_calendar_event_drop_recurrence
-- Removes is_recurring and recurring_rule from calendar_events.
-- These columns were written at two call sites (create, update) and read by
-- no code anywhere in the codebase.  A written-never-read column is worse
-- than a missing feature; a full RFC 5545 recurrence engine is a separate
-- feature ticket.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "calendar_events"
  DROP COLUMN "is_recurring",
  DROP COLUMN "recurring_rule";

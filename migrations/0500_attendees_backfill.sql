-- 0500_attendees_backfill
-- Backfills event_attendees from the JSONB attendee_ids column on
-- calendar_events, making event_attendees the canonical attendee source (c16-08).
--
-- The attendee_ids column remains after this migration.  Removing it from the
-- Drizzle schema (common/shared.ts) and issuing the DROP COLUMN must be done in
-- a subsequent deployment once dual-read parity is confirmed, because that file
-- is shared across the codebase and cannot be edited during a parallel fan-out.
--
-- New rows receive status='pending'.  Any existing event_attendees row (e.g.
-- from an RSVP) is left untouched (ON CONFLICT DO NOTHING).
--
-- REQUIRED AFTER APPLYING:  VACUUM ANALYZE event_attendees;
-- This migration inserts rows; statistics will be stale immediately after.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO event_attendees (event_id, user_id, status, created_at, updated_at)
SELECT
  ce.id,
  elem,
  'pending',
  NOW(),
  NOW()
FROM calendar_events ce
CROSS JOIN LATERAL jsonb_array_elements_text(ce.attendee_ids) AS elem
WHERE jsonb_array_length(ce.attendee_ids) > 0
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = elem)
ON CONFLICT (event_id, user_id) DO NOTHING;

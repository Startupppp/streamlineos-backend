SET lock_timeout = '5s';

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS attendee_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE calendar_events event
SET attendee_ids = COALESCE(
  (
    SELECT jsonb_agg(attendee.user_id ORDER BY attendee.membership_id)
    FROM event_attendees attendee
    WHERE attendee.org_id = event.org_id
      AND attendee.event_id = event.id
      AND attendee.user_id IS NOT NULL
  ),
  '[]'::jsonb
);

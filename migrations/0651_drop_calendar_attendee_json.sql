DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM calendar_events event
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE(event.attendee_ids, '[]'::jsonb)) legacy(user_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM event_attendees attendee
        WHERE attendee.org_id = event.org_id
          AND attendee.event_id = event.id
          AND attendee.user_id = legacy.user_id
      )
    )
  ) THEN
    RAISE EXCEPTION 'calendar_events.attendee_ids has unmigrated data';
  END IF;
END $$;

ALTER TABLE calendar_events DROP COLUMN IF EXISTS attendee_ids;

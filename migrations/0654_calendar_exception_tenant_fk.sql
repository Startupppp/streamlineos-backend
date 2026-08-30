SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM calendar_event_exceptions exception
    LEFT JOIN calendar_events event
      ON event.org_id = exception.org_id
     AND event.id = exception.event_id
    WHERE event.id IS NULL
  ) THEN
    RAISE EXCEPTION 'calendar event exceptions contain cross-tenant or orphaned events';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_calendar_event_exceptions_org_event'
  ) THEN
    ALTER TABLE calendar_event_exceptions
      ADD CONSTRAINT fk_calendar_event_exceptions_org_event
      FOREIGN KEY (org_id, event_id) REFERENCES calendar_events (org_id, id)
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE calendar_event_exceptions
  VALIDATE CONSTRAINT fk_calendar_event_exceptions_org_event;

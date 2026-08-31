SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_event_attendees_event_id_org'
      AND conrelid = 'event_attendees'::regclass
  ) THEN
    RAISE EXCEPTION '0802: fk_event_attendees_event_id_org still present — 0801 must run first';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_event_exceptions_event_id_fkey'
      AND conrelid = 'calendar_event_exceptions'::regclass
  ) THEN
    ALTER TABLE calendar_event_exceptions
      DROP CONSTRAINT calendar_event_exceptions_event_id_fkey;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_calendar_event_exceptions_org_event'
      AND conrelid = 'calendar_event_exceptions'::regclass
      AND contype = 'f'
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION '0802: fk_calendar_event_exceptions_org_event (CASCADE) composite FK is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_event_exceptions_event_id_fkey'
      AND conrelid = 'calendar_event_exceptions'::regclass
  ) THEN
    RAISE EXCEPTION '0802: calendar_event_exceptions_event_id_fkey legacy FK was not removed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid IN (
      'calendar_events'::regclass,
      'event_attendees'::regclass,
      'calendar_event_exceptions'::regclass,
      'calendar_source_preferences'::regclass
    )
    AND c.contype = 'f'
    AND c.confdeltype = 'n'
    AND array_length(c.conkey, 1) > 1
    AND (c.confdelsetcols IS NULL OR array_length(c.confdelsetcols, 1) != 1)
  ) THEN
    RAISE EXCEPTION '0802: composite SET NULL FK without a single-column confdelsetcols — org_id nulling risk (23502)';
  END IF;
END $$;

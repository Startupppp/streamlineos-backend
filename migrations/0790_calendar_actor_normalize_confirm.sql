SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('calendar_events', 'event_attendees', 'calendar_event_exceptions', 'calendar_source_preferences')
      AND column_name IN ('user_id', 'created_by_user_id', 'actor_user_id')
  ) THEN
    RAISE EXCEPTION '0790: legacy user-keyed column found on a calendar table — drop it before this migration can succeed';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'calendar_events' AND column_name = 'created_by_membership_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0790: calendar_events.created_by_membership_id is missing or nullable — normalization incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_attendees' AND column_name = 'membership_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0790: event_attendees.membership_id is missing or nullable — normalization incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'calendar_source_preferences' AND column_name = 'membership_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0790: calendar_source_preferences.membership_id is missing or nullable — normalization incomplete';
  END IF;
END $$;

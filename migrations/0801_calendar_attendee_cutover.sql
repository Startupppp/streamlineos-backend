SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('calendar_events', 'event_attendees', 'calendar_event_exceptions', 'calendar_source_preferences')
      AND column_name IN ('user_id', 'created_by_user_id', 'actor_user_id', 'created_by')
  ) THEN
    RAISE EXCEPTION '0801: legacy user-keyed column present on a calendar table — 0790 must run first';
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'calendar_events'
      AND column_name = 'created_by_membership_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0801: calendar_events.created_by_membership_id is missing or nullable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'event_attendees'
      AND column_name = 'membership_id'
      AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0801: event_attendees.membership_id is missing or nullable';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS calendar_actor_migration_report (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id INTEGER,
  issue_type TEXT NOT NULL,
  org_id TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_cal_actor_report_org_table
  ON calendar_actor_migration_report (org_id, table_name);
--> statement-breakpoint

INSERT INTO calendar_actor_migration_report (table_name, row_id, issue_type, org_id, detail)
SELECT
  'event_attendees',
  ea.id,
  'CROSS_TENANT_ATTENDEE',
  ea.org_id,
  jsonb_build_object(
    'event_id', ea.event_id,
    'membership_id', ea.membership_id,
    'attendee_org_id', ea.org_id,
    'event_org_id', ce.org_id
  )
FROM event_attendees ea
JOIN calendar_events ce ON ce.id = ea.event_id
WHERE ea.org_id != ce.org_id;
--> statement-breakpoint

INSERT INTO calendar_actor_migration_report (table_name, row_id, issue_type, org_id, detail)
SELECT
  'event_attendees',
  ea.id,
  'ORPHANED_MEMBERSHIP',
  ea.org_id,
  jsonb_build_object(
    'event_id', ea.event_id,
    'membership_id', ea.membership_id
  )
FROM event_attendees ea
WHERE NOT EXISTS (
  SELECT 1 FROM organization_members om
  WHERE om.org_id = ea.org_id AND om.id = ea.membership_id
);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_event_attendees_event_id_org'
      AND conrelid = 'event_attendees'::regclass
  ) THEN
    ALTER TABLE event_attendees
      DROP CONSTRAINT fk_event_attendees_event_id_org;
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_event_attendees_event_id;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_event_attendees_org_event
  ON event_attendees (org_id, event_id);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_event_attendees_event_id_org'
      AND conrelid = 'event_attendees'::regclass
  ) THEN
    RAISE EXCEPTION '0801: duplicate fk_event_attendees_event_id_org was not removed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_event_attendees_org_event'
      AND conrelid = 'event_attendees'::regclass
      AND contype = 'f'
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION '0801: fk_event_attendees_org_event (CASCADE) is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_event_attendees_org_membership'
      AND conrelid = 'event_attendees'::regclass
      AND contype = 'f'
  ) THEN
    RAISE EXCEPTION '0801: fk_event_attendees_org_membership composite FK is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'event_attendees'
      AND indexname = 'idx_event_attendees_org_event'
  ) THEN
    RAISE EXCEPTION '0801: idx_event_attendees_org_event is missing';
  END IF;
END $$;

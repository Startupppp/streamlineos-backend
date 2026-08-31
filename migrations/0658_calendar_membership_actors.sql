SET lock_timeout = '5s';

ALTER TABLE organization_members
  ADD CONSTRAINT uniq_org_members_org_user UNIQUE (org_id, user_id);

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;

UPDATE calendar_events event
SET created_by_membership_id = member.id
FROM organization_members member
WHERE member.org_id = event.org_id
  AND member.user_id = event.created_by
  AND event.created_by_membership_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM calendar_events WHERE created_by_membership_id IS NULL) THEN
    RAISE EXCEPTION 'calendar event actor backfill has unmappable rows';
  END IF;
END $$;

ALTER TABLE calendar_events
  ALTER COLUMN created_by_membership_id SET NOT NULL;

ALTER TABLE calendar_events
  ADD CONSTRAINT fk_calendar_events_org_creator_membership
  FOREIGN KEY (org_id, created_by_membership_id)
  REFERENCES organization_members (org_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_calendar_events_org_creator_membership
  ON calendar_events (org_id, created_by_membership_id, start_date);

ALTER TABLE event_attendees
  ADD CONSTRAINT fk_event_attendees_org_user
  FOREIGN KEY (org_id, user_id)
  REFERENCES organization_members (org_id, user_id)
  ON DELETE RESTRICT NOT VALID;

ALTER TABLE event_attendees
  VALIDATE CONSTRAINT fk_event_attendees_org_user;

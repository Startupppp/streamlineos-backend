SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS communication_backfill_issues (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE event_attendees ADD COLUMN IF NOT EXISTS membership_id INTEGER;

UPDATE event_attendees attendee
SET org_id = event.org_id
FROM calendar_events event
WHERE event.id = attendee.event_id
  AND attendee.org_id IS NULL;

UPDATE event_attendees attendee
SET membership_id = member.id
FROM organization_members member
WHERE member.org_id = attendee.org_id
  AND member.user_id = attendee.user_id
  AND attendee.membership_id IS NULL;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT attendee.org_id, 'calendar_attendee', attendee.id::text,
  'unmappable_membership', jsonb_build_object('eventId', attendee.event_id, 'userId', attendee.user_id)
FROM event_attendees attendee
WHERE attendee.membership_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_attendees WHERE org_id IS NULL OR membership_id IS NULL) THEN
    RAISE EXCEPTION 'calendar attendee backfill has unmappable rows; see communication_backfill_issues';
  END IF;
END $$;

ALTER TABLE event_attendees DROP CONSTRAINT IF EXISTS event_attendees_event_user_unique;
ALTER TABLE event_attendees DROP CONSTRAINT IF EXISTS event_attendees_event_id_calendar_events_id_fk;
ALTER TABLE event_attendees DROP CONSTRAINT IF EXISTS event_attendees_user_id_users_id_fk;
ALTER TABLE event_attendees ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE event_attendees ALTER COLUMN membership_id SET NOT NULL;
ALTER TABLE event_attendees
  ADD CONSTRAINT fk_event_attendees_org_event
  FOREIGN KEY (org_id, event_id) REFERENCES calendar_events (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE event_attendees
  ADD CONSTRAINT fk_event_attendees_org_membership
  FOREIGN KEY (org_id, membership_id) REFERENCES organization_members (org_id, id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE event_attendees VALIDATE CONSTRAINT fk_event_attendees_org_event;
ALTER TABLE event_attendees VALIDATE CONSTRAINT fk_event_attendees_org_membership;
CREATE UNIQUE INDEX IF NOT EXISTS event_attendees_event_membership_unique
  ON event_attendees (org_id, event_id, membership_id);
CREATE INDEX IF NOT EXISTS idx_event_attendees_event_id ON event_attendees (org_id, event_id);
CREATE INDEX IF NOT EXISTS idx_event_attendees_membership_id ON event_attendees (org_id, membership_id);

CREATE TABLE IF NOT EXISTS chat_message_reactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  membership_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_chat_message_reactions_org_message
    FOREIGN KEY (org_id, message_id) REFERENCES chat_messages (org_id, id) ON DELETE CASCADE NOT VALID,
  CONSTRAINT fk_chat_message_reactions_org_membership
    FOREIGN KEY (org_id, membership_id) REFERENCES organization_members (org_id, id) ON DELETE CASCADE NOT VALID
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_message_reaction_actor_emoji
  ON chat_message_reactions (org_id, message_id, membership_id, emoji);

INSERT INTO chat_message_reactions (org_id, message_id, membership_id, emoji)
SELECT message.org_id, message.id, member.id, reaction.emoji
FROM chat_messages message
CROSS JOIN LATERAL jsonb_object_keys(message.reactions) AS reaction(emoji)
CROSS JOIN LATERAL jsonb_array_elements_text(message.reactions -> reaction.emoji) AS reactor(user_id)
JOIN organization_members member
  ON member.org_id = message.org_id
 AND member.user_id = reactor.user_id
ON CONFLICT (org_id, message_id, membership_id, emoji) DO NOTHING;

INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT message.org_id, 'chat_reaction', message.id::text,
  'duplicate_legacy_reaction_removed', jsonb_build_object('emoji', reaction.emoji, 'userId', reactor.user_id, 'count', COUNT(*) - 1)
FROM chat_messages message
CROSS JOIN LATERAL jsonb_object_keys(message.reactions) AS reaction(emoji)
CROSS JOIN LATERAL jsonb_array_elements_text(message.reactions -> reaction.emoji) AS reactor(user_id)
GROUP BY message.org_id, message.id, reaction.emoji, reactor.user_id
HAVING COUNT(*) > 1;

ALTER TABLE chat_message_reactions VALIDATE CONSTRAINT fk_chat_message_reactions_org_message;
ALTER TABLE chat_message_reactions VALIDATE CONSTRAINT fk_chat_message_reactions_org_membership;
CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_message
  ON chat_message_reactions (org_id, message_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_membership
  ON chat_message_reactions (org_id, membership_id);

ALTER TABLE chat_messages DROP COLUMN IF EXISTS reactions;

SET lock_timeout = '5s';

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

ALTER TABLE chat_message_reactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_message_reactions_tenant_isolation ON chat_message_reactions;
CREATE POLICY chat_message_reactions_tenant_isolation ON chat_message_reactions
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_message_reaction_actor_emoji
  ON chat_message_reactions (org_id, message_id, membership_id, emoji);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'chat_messages'
      AND column_name = 'reactions'
  ) THEN
    INSERT INTO chat_message_reactions (org_id, message_id, membership_id, emoji)
    SELECT message.org_id, message.id, member.id, reaction.emoji
    FROM chat_messages message
    CROSS JOIN LATERAL jsonb_object_keys(message.reactions) AS reaction(emoji)
    CROSS JOIN LATERAL jsonb_array_elements_text(message.reactions -> reaction.emoji) AS reactor(user_id)
    JOIN organization_members member
      ON member.org_id = message.org_id
     AND member.user_id = reactor.user_id
    ON CONFLICT (org_id, message_id, membership_id, emoji) DO NOTHING;
    ALTER TABLE chat_messages DROP COLUMN reactions;
  END IF;
END $$;

ALTER TABLE chat_message_reactions VALIDATE CONSTRAINT fk_chat_message_reactions_org_message;
ALTER TABLE chat_message_reactions VALIDATE CONSTRAINT fk_chat_message_reactions_org_membership;

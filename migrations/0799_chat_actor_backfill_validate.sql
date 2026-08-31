SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_channels' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_channels' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_channels
      SET created_by_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_channels.org_id
          AND om.user_id = chat_channels.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL
        AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'sender_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_messages' AND column_name = 'sender_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_messages
      SET sender_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_messages.org_id
          AND om.user_id = chat_messages.sender_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE sender_membership_id IS NULL
        AND sender_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages' AND column_name = 'pinned_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_pinned_messages' AND column_name = 'pinned_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_pinned_messages
      SET pinned_by_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_pinned_messages.org_id
          AND om.user_id = chat_pinned_messages.pinned_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE pinned_by_membership_id IS NULL
        AND pinned_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders' AND column_name = 'recipient_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders' AND column_name = 'recipient_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_reply_reminders
      SET recipient_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_reply_reminders.org_id
          AND om.user_id = chat_reply_reminders.recipient_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE recipient_membership_id IS NULL
        AND recipient_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders' AND column_name = 'sender_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_reply_reminders' AND column_name = 'sender_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE chat_reply_reminders
      SET sender_membership_id = (
        SELECT om.id
        FROM organization_members om
        WHERE om.org_id = chat_reply_reminders.org_id
          AND om.user_id = chat_reply_reminders.sender_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE sender_membership_id IS NULL
        AND sender_user_id IS NOT NULL
    $q$;
  END IF;
END $$;
--> statement-breakpoint

UPDATE chat_reply_reminders
SET cancelled_at = now()
WHERE cancelled_at IS NULL
  AND sent_at IS NULL
  AND recipient_membership_id IS NULL;
--> statement-breakpoint

ALTER TABLE chat_channels VALIDATE CONSTRAINT fk_chat_channels_org_created_by_membership;
--> statement-breakpoint

ALTER TABLE chat_messages VALIDATE CONSTRAINT fk_chat_messages_org_sender_membership;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_chat_pinned_messages_org_pinner_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE chat_pinned_messages
      ADD CONSTRAINT fk_chat_pinned_messages_org_pinner_membership
        FOREIGN KEY (org_id, pinned_by_membership_id)
        REFERENCES organization_members (org_id, id)
        ON DELETE SET NULL (pinned_by_membership_id)
        NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_chat_reply_reminders_org_recipient_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE chat_reply_reminders
      ADD CONSTRAINT fk_chat_reply_reminders_org_recipient_membership
        FOREIGN KEY (org_id, recipient_membership_id)
        REFERENCES organization_members (org_id, id)
        ON DELETE SET NULL (recipient_membership_id)
        NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_chat_reply_reminders_org_sender_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE chat_reply_reminders
      ADD CONSTRAINT fk_chat_reply_reminders_org_sender_membership
        FOREIGN KEY (org_id, sender_membership_id)
        REFERENCES organization_members (org_id, id)
        ON DELETE SET NULL (sender_membership_id)
        NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE chat_pinned_messages VALIDATE CONSTRAINT fk_chat_pinned_messages_org_pinner_membership;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_recipient_membership;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_sender_membership;
--> statement-breakpoint

DROP INDEX IF EXISTS uniq_chat_reply_reminder;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS uniq_chat_reply_reminder
  ON chat_reply_reminders (message_id, recipient_membership_id)
  WHERE recipient_membership_id IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_chat_reply_reminders_recipient;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_chat_reply_reminders_recipient
  ON chat_reply_reminders (recipient_membership_id, channel_id);
--> statement-breakpoint

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
  FROM pg_constraint c
  WHERE c.conname IN (
      'fk_chat_pinned_messages_org_pinner_membership',
      'fk_chat_reply_reminders_org_recipient_membership',
      'fk_chat_reply_reminders_org_sender_membership'
    )
    AND c.contype = 'f'
    AND c.confdeltype = 'n'
    AND (c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0799: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'chat_message_reactions' AND indexname = 'uniq_chat_message_reaction_actor_emoji'
  ) THEN
    RAISE EXCEPTION '0799: uniq_chat_message_reaction_actor_emoji is missing — reaction uniqueness not enforced';
  END IF;
END $$;

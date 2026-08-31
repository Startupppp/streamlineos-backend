SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE chat_channels
  DROP CONSTRAINT IF EXISTS chat_channels_created_by_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_channels
  DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_sender_id_users_id_fk;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_chat_messages_sender;
--> statement-breakpoint

ALTER TABLE chat_messages
  DROP COLUMN IF EXISTS sender_id;
--> statement-breakpoint

ALTER TABLE chat_pinned_messages
  DROP CONSTRAINT IF EXISTS chat_pinned_messages_pinned_by_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_pinned_messages
  DROP COLUMN IF EXISTS pinned_by;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders
  DROP CONSTRAINT IF EXISTS chat_reply_reminders_recipient_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders
  DROP CONSTRAINT IF EXISTS chat_reply_reminders_sender_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders
  DROP COLUMN IF EXISTS recipient_user_id;
--> statement-breakpoint

ALTER TABLE chat_reply_reminders
  DROP COLUMN IF EXISTS sender_user_id;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_channels' AND column_name = 'created_by'
  ) THEN
    RAISE EXCEPTION '0800: created_by column still exists on chat_channels after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'sender_id'
  ) THEN
    RAISE EXCEPTION '0800: sender_id column still exists on chat_messages after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_pinned_messages' AND column_name = 'pinned_by'
  ) THEN
    RAISE EXCEPTION '0800: pinned_by column still exists on chat_pinned_messages after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_reply_reminders' AND column_name = 'recipient_user_id'
  ) THEN
    RAISE EXCEPTION '0800: recipient_user_id column still exists on chat_reply_reminders after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_reply_reminders' AND column_name = 'sender_user_id'
  ) THEN
    RAISE EXCEPTION '0800: sender_user_id column still exists on chat_reply_reminders after drop';
  END IF;
END
$$;

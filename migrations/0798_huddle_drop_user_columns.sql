SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE chat_huddles
  DROP CONSTRAINT IF EXISTS chat_huddles_started_by_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_huddles
  DROP COLUMN started_by;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants
  DROP CONSTRAINT IF EXISTS chat_huddle_participants_user_id_users_id_fk;
--> statement-breakpoint

ALTER TABLE chat_huddle_participants
  DROP COLUMN user_id;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_huddles' AND column_name = 'started_by'
  ) THEN
    RAISE EXCEPTION 'started_by column still exists on chat_huddles after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_huddle_participants' AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION 'user_id column still exists on chat_huddle_participants after drop';
  END IF;
END
$$;

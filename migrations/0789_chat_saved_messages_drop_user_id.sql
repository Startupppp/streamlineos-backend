SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_saved_message";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_saved_messages_user";
--> statement-breakpoint

ALTER TABLE "chat_saved_messages" DROP COLUMN "user_id";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_saved_messages'
      AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION '0789: user_id column still present in chat_saved_messages after drop';
  END IF;
END $$;

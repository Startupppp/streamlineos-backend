SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM chat_saved_messages
  WHERE membership_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION '0788: % chat_saved_messages rows still have null membership_id — run backfill-chat-saved-messages-membership first', orphan_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "chat_saved_messages"
  ADD CONSTRAINT "chk_chat_saved_msg_membership_not_null"
  CHECK ("membership_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "chat_saved_messages" VALIDATE CONSTRAINT "chk_chat_saved_msg_membership_not_null";
--> statement-breakpoint

ALTER TABLE "chat_saved_messages" ALTER COLUMN "membership_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "chat_saved_messages" DROP CONSTRAINT "chk_chat_saved_msg_membership_not_null";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_saved_msg_membership"
  ON "chat_saved_messages" ("org_id", "membership_id", "message_id");
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'chat_saved_messages'
      AND indexname = 'uniq_chat_saved_msg_membership'
  ) THEN
    RAISE EXCEPTION '0788: unique index uniq_chat_saved_msg_membership was not created';
  END IF;
END $$;

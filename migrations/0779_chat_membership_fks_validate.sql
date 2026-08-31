SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "chat_channels" VALIDATE CONSTRAINT "fk_chat_channels_org_created_by_membership";
--> statement-breakpoint

ALTER TABLE "chat_messages" VALIDATE CONSTRAINT "fk_chat_messages_org_sender_membership";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN (
        'fk_chat_channels_org_created_by_membership',
        'fk_chat_messages_org_sender_membership'
      )
      AND contype = 'f'
      AND NOT convalidated
  ) THEN
    RAISE EXCEPTION '0779: chat membership foreign key left NOT VALID — it enforces nothing for existing rows';
  END IF;
END $$;

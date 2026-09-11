-- 0980_chat_message_client_idempotency DOWN
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_chat_messages_client_key";
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "client_key";

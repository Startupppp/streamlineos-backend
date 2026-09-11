-- S08: message send had no durable idempotency. A client whose response is lost
-- retries and inserts a second message; nothing made the retry a no-op. The key is
-- nullable and the unique index is partial, so every existing row is untouched and
-- callers that send no key keep their current behaviour.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "client_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_messages_client_key" ON "chat_messages" ("org_id", "channel_id", "client_key") WHERE "client_key" IS NOT NULL;

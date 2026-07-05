ALTER TABLE "chat_channel_members" ADD COLUMN IF NOT EXISTS "is_favorite" boolean DEFAULT false NOT NULL;
ALTER TABLE "chat_channel_members" ADD COLUMN IF NOT EXISTS "notification_preference" text DEFAULT 'DEFAULT' NOT NULL;

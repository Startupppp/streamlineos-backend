-- 0981_chat_channel_privacy_invariant DOWN
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_channels" DROP CONSTRAINT IF EXISTS "chk_chat_channels_privacy_matches_type";

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_channel_member_membership" ON "chat_channel_members" ("org_id", "channel_id", "membership_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_channel_member";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_chat_members_user";
--> statement-breakpoint
ALTER TABLE "chat_channel_members" DROP CONSTRAINT IF EXISTS "chat_channel_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_channel_members" DROP COLUMN IF EXISTS "user_id";

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_user_presence" DROP CONSTRAINT IF EXISTS "fk_chat_user_presence_org_membership";
--> statement-breakpoint
ALTER TABLE "chat_user_presence"
  ADD CONSTRAINT "fk_chat_user_presence_org_membership"
  FOREIGN KEY ("org_id", "membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_user_presence" VALIDATE CONSTRAINT "fk_chat_user_presence_org_membership";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_chat_presence_org_user";
--> statement-breakpoint
ALTER TABLE "chat_user_presence" DROP CONSTRAINT IF EXISTS "chat_user_presence_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_user_presence" DROP COLUMN IF EXISTS "user_id";

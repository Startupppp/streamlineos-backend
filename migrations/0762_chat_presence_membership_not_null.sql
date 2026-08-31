SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_user_presence"
  ADD CONSTRAINT "chk_cup_membership_id_not_null"
  CHECK (membership_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_user_presence" VALIDATE CONSTRAINT "chk_cup_membership_id_not_null";
--> statement-breakpoint
ALTER TABLE "chat_user_presence" ALTER COLUMN "membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_user_presence" DROP CONSTRAINT "chk_cup_membership_id_not_null";

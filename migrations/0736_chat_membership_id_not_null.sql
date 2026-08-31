SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_channel_members"
  ADD CONSTRAINT "chk_ccm_membership_id_not_null"
  CHECK (membership_id IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "chat_channel_members"
  VALIDATE CONSTRAINT "chk_ccm_membership_id_not_null";
--> statement-breakpoint
ALTER TABLE "chat_channel_members"
  ALTER COLUMN "membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_channel_members"
  DROP CONSTRAINT "chk_ccm_membership_id_not_null";

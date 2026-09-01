-- Rollback 0920 before legacy-column contract/drop.
-- Membership pointers are additive and can be discarded while legacy projections remain.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "ai_action_proposals" DROP CONSTRAINT IF EXISTS "fk_ai_proposals_org_user_mbr";
ALTER TABLE "ai_chat_messages" DROP CONSTRAINT IF EXISTS "fk_ai_chat_msg_org_user_mbr";
ALTER TABLE "ai_chat_conversations" DROP CONSTRAINT IF EXISTS "fk_ai_chat_conv_org_user_mbr";

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_ai_proposals_org_user_membership_created";
DROP INDEX IF EXISTS "idx_ai_chat_messages_org_user_membership_id";
DROP INDEX IF EXISTS "idx_ai_chat_conversations_org_user_membership_updated";

--> statement-breakpoint
ALTER TABLE "ai_action_proposals" DROP COLUMN IF EXISTS "user_membership_id";
ALTER TABLE "ai_chat_messages" DROP COLUMN IF EXISTS "user_membership_id";
ALTER TABLE "ai_chat_conversations" DROP COLUMN IF EXISTS "user_membership_id";

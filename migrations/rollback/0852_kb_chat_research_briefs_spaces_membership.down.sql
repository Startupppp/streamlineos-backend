-- Rollback 0852: drop the kb_chat_conversations, kb_chat_messages, kb_research_briefs,
-- and kb_spaces membership-id columns.
--
-- @data-loss — the backfilled user_membership_id / created_by_membership_id pointers are
-- discarded. This is acceptable: the legacy user_id and created_by_id columns are still
-- present and still populated, so all four tables return to a working state.
--
-- Roll the code back first. Services that have been cut over to dual-read the membership
-- columns will fail 42703 on the next read if the columns are dropped under a running
-- deployment.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" DROP CONSTRAINT IF EXISTS "fk_kb_chat_conv_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages" DROP CONSTRAINT IF EXISTS "fk_kb_chat_msg_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP CONSTRAINT IF EXISTS "fk_kb_research_briefs_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
ALTER TABLE "kb_spaces" DROP CONSTRAINT IF EXISTS "fk_kb_spaces_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "kb_spaces" DROP COLUMN IF EXISTS "created_by_membership_id";

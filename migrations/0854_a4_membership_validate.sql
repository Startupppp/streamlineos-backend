-- 0854: VALIDATE NOT VALID FK constraints from migrations 0852-0853 (Lane A4).
--
-- VALIDATE CONSTRAINT acquires ShareUpdateExclusiveLock (not ACCESS EXCLUSIVE), so it
-- can run while the table is still writable. Run after backfill is confirmed complete.
-- Each VALIDATE is a separate statement so a single failure doesn't abort the rest.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" VALIDATE CONSTRAINT "fk_kb_chat_conv_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages" VALIDATE CONSTRAINT "fk_kb_chat_msg_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs" VALIDATE CONSTRAINT "fk_kb_research_briefs_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_spaces" VALIDATE CONSTRAINT "fk_kb_spaces_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" VALIDATE CONSTRAINT "fk_fin_approval_policies_org_mbr";

--> statement-breakpoint
ALTER TABLE "journal_entries" VALIDATE CONSTRAINT "fk_je_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "affiliates" VALIDATE CONSTRAINT "fk_affiliates_org_user_mbr";

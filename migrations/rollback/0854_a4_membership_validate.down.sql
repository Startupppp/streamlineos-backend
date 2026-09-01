-- Rollback 0854: un-validate the FK constraints from migrations 0852-0853 (Lane A4).
--
-- VALIDATE CONSTRAINT cannot be undone directly; the only way to return to the
-- NOT VALID state is to drop each constraint and re-add it NOT VALID. No column is
-- dropped and no backfilled data is lost.
--
-- Roll the code back first if services have already switched to using these columns
-- as the authoritative ownership pointer.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" DROP CONSTRAINT IF EXISTS "fk_kb_chat_conv_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_conversations"
  ADD CONSTRAINT "fk_kb_chat_conv_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_chat_messages" DROP CONSTRAINT IF EXISTS "fk_kb_chat_msg_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_chat_messages"
  ADD CONSTRAINT "fk_kb_chat_msg_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_research_briefs" DROP CONSTRAINT IF EXISTS "fk_kb_research_briefs_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "kb_research_briefs"
  ADD CONSTRAINT "fk_kb_research_briefs_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "kb_spaces" DROP CONSTRAINT IF EXISTS "fk_kb_spaces_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "kb_spaces"
  ADD CONSTRAINT "fk_kb_spaces_org_created_by_mbr"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "fin_approval_policies" DROP CONSTRAINT IF EXISTS "fk_fin_approval_policies_org_mbr";

--> statement-breakpoint
ALTER TABLE "fin_approval_policies"
  ADD CONSTRAINT "fk_fin_approval_policies_org_mbr"
  FOREIGN KEY ("org_id", "approver_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("approver_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT IF EXISTS "fk_je_org_created_by_mbr";

--> statement-breakpoint
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "fk_je_org_created_by_mbr"
  FOREIGN KEY ("org_id", "created_by_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("created_by_membership_id")
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "fk_affiliates_org_user_mbr";

--> statement-breakpoint
ALTER TABLE "affiliates"
  ADD CONSTRAINT "fk_affiliates_org_user_mbr"
  FOREIGN KEY ("org_id", "user_membership_id")
  REFERENCES "organization_members" ("org_id", "id")
  ON DELETE SET NULL ("user_membership_id")
  NOT VALID;

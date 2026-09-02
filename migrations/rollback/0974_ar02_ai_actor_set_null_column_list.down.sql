-- 0974_ar02_ai_actor_set_null_column_list DOWN — reverses the up migration; each restored constraint is rebuilt from the definition recorded in pg_catalog before it was dropped.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE ai_action_proposals DROP CONSTRAINT IF EXISTS "fk_ai_proposals_org_user_mbr";
--> statement-breakpoint
ALTER TABLE ai_action_proposals
  ADD CONSTRAINT "fk_ai_proposals_org_user_mbr"
  FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE ai_chat_messages DROP CONSTRAINT IF EXISTS "fk_ai_chat_msg_org_user_mbr";
--> statement-breakpoint
ALTER TABLE ai_chat_messages
  ADD CONSTRAINT "fk_ai_chat_msg_org_user_mbr"
  FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE ai_chat_conversations DROP CONSTRAINT IF EXISTS "fk_ai_chat_conv_org_user_mbr";
--> statement-breakpoint
ALTER TABLE ai_chat_conversations
  ADD CONSTRAINT "fk_ai_chat_conv_org_user_mbr"
  FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
  NOT VALID;

-- 1066 DOWN — drops the chat_message_reactions composite tenant unique constraint.
--
-- @reopens-a-defect: chat_message_reactions loses the (org_id, id) uniqueness guarantee
-- that every other chat table provides, making it impossible for a future table to carry
-- a composite (org_id, reaction_id) FK and keep the tenant edge alongside the reference.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "chat_message_reactions"
  DROP CONSTRAINT IF EXISTS "uniq_chat_message_reactions_org_id";

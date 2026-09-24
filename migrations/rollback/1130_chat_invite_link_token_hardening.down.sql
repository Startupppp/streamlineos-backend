-- Rollback for migration 1130.
--
-- WARNING: this rollback restores the schema structure only.
-- The plaintext token values that were erased in the forward migration
-- CANNOT be recovered — they were permanently destroyed.
-- Rows that previously had token IS NOT NULL now have token = NULL and
-- will remain so after this rollback.  Those invite links are still joinable
-- via token_hash, but an admin refresh is required to obtain a new link token.

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  DROP CONSTRAINT IF EXISTS "chat_invite_link_token_hash_not_null";
--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links"
  ALTER COLUMN "token_hash" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_invite_link_token"
  ON "chat_channel_invite_links" ("token");

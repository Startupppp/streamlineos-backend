-- Rollback for 1080 — structurally reversible, NOT data-reversible.
--
-- WHAT COMES BACK. The three columns and the partial unique index are removed.
--
-- WHAT DOES NOT COME BACK. Every value of expires_at, max_uses and use_count
-- is destroyed. After this rollback, every invite link has no expiry, no usage
-- cap and a use_count that is meaningless (the column no longer exists).
-- Any link that was created with a TTL while 1080 was applied will be valid
-- again in the eyes of the old code (no expiry column to check).

SET lock_timeout = '5s';

DROP INDEX IF EXISTS "uniq_chat_invite_active_link_channel";

ALTER TABLE "chat_channel_invite_links" DROP COLUMN IF EXISTS "use_count";
ALTER TABLE "chat_channel_invite_links" DROP COLUMN IF EXISTS "max_uses";
ALTER TABLE "chat_channel_invite_links" DROP COLUMN IF EXISTS "expires_at";

RESET lock_timeout;

-- Chat presence was globally unique on user_id, so a person who is an active member
-- of two organizations could only ever hold ONE presence row. The upsert conflicted on
-- that row and updated status/last_seen_at without touching org_id, so their activity in
-- org B kept marking them online in org A, and they never appeared online in org B at all.
-- Presence is per-membership, not per-human: the key becomes (org_id, user_id).
--
-- Safe to run unguarded: the old global unique made (org_id, user_id) trivially unique,
-- so no duplicate rows can exist to block the new index.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_chat_presence_user";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_presence_org_user" ON "chat_user_presence" ("org_id","user_id");

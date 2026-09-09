-- 1074 DOWN — removes the commit-ordered read cursor and returns chat_channel_members to
-- the shape it had at journal head 1073.
--
-- @reopens-a-defect: this reinstates the defect 1074 exists to fix. With
-- `last_read_position` gone the only cursor left is `last_read_at`, which is compared
-- against `chat_messages.created_at` — and `created_at` is `DEFAULT now()`, i.e.
-- TRANSACTION START, while `TenantContextInterceptor` holds one transaction per request.
-- A send that queues on the channel row lock therefore commits AFTER a mark-read while
-- carrying a timestamp from BEFORE it, and both unread counters
-- (`chat-channel-list.service.ts`, `chat-presence.service.ts`) count it as already read.
-- Permanently: nothing revisits the comparison, so the message is never unread again. NTP
-- skew between the API host and the database loses messages the same way with no
-- concurrency at all.
--
-- REVERT THE CODE IN THE SAME CHANGE. Running this file alone leaves both counters, both
-- writers and both insert sites referencing a column that no longer exists, and every chat
-- read fails 42703 rather than degrading — a total outage of the sidebar and the badge.
-- The call sites are:
--   src/db/schema/chat/chat-channel-tables.ts        lastReadPosition
--   src/db/schema/chat/chat-message-tables.ts        idx_chat_messages_unread_position
--   src/modules/chat/chat-channel-list.service.ts    the per-channel count predicate
--   src/modules/chat/chat-presence.service.ts        the badge total predicate
--   src/modules/chat/chat-channel-members-implementation.ts
--                                                    channelHighWaterMark, markRead,
--                                                    markChannelUnread, addMember,
--                                                    joinOpenChannel
--
-- DATA LOSS, deliberately unrecoverable in this direction: dropping the column discards
-- every cursor advance made while 1074 was applied. The forward file can derive
-- `last_read_position` from `last_read_at` again, but not the other way round — a position
-- has no timestamp to map back to. Both writers kept `last_read_at` in step with the
-- position, so re-applying 1074 recovers a cursor within one message of the true one
-- rather than resetting anyone to zero.
--
-- `idx_chat_messages_unread` is NOT touched here: 1074 never modified it, and it is the
-- only index serving the channel-list last-message LATERAL's ORDER BY created_at DESC.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_chat_messages_unread_position";
--> statement-breakpoint

ALTER TABLE "chat_channel_members" DROP COLUMN IF EXISTS "last_read_position";

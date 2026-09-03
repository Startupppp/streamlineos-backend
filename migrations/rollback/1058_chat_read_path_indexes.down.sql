-- 1058 DOWN — returns the three chat read-path indexes to the shapes they had at journal
-- head 1054.
--
-- @reopens-a-defect: each of the three is the fix for a measured defect, and running this
-- puts all three back.
--
--   * Re-narrowing idx_chat_messages_channel_position to `WHERE is_deleted = false` makes
--     it unusable for GET /chat/channels/:id/messages, which carries no is_deleted
--     predicate because it renders tombstones. Measured: 0.256 ms / 54 buffers becomes
--     1772.6 ms / 5,022 buffers on a 5,000-message channel, and the bad plan reads the
--     whole channel so it degrades linearly with history. Revert `poll()`'s tombstone
--     change in src/modules/chat/chat-message-timeline.service.ts in the same change or
--     the poll's forward scan loses its index too.
--   * Dropping idx_chat_messages_org_reply puts every thread-panel open back on a parallel
--     sequential scan of the tenant's whole chat_messages table: 0.079 ms / 8 buffers
--     becomes 47.4 ms / 6,904 buffers at 400,000 rows, O(tenant) not O(thread).
--   * Dropping uniq_chat_channels_org_entity removes the ONLY thing preventing two chat
--     channels for one record. Revert the ON CONFLICT in
--     ChatChannelsService.getOrCreateEntityChannel in the same change: its
--     `onConflictDoNothing` target names this index, and without the index the statement
--     raises SQLSTATE 42P10 at plan time (the 1054 defect), so leaving the code and
--     dropping the index turns a rare race into a total outage of that route.
--
-- NOT REVERSED, deliberately: the duplicate entity channels the forward file unbound. It
-- set entity_type/entity_id to NULL on the newer of each duplicate pair and recorded every
-- one in communication_backfill_issues with reason 'duplicate_entity_channel_unbound'.
-- Re-binding them automatically would recreate exactly the ambiguity the unique index
-- exists to prevent, and this file cannot know whether an operator has since merged the
-- conversations. Read the audit rows and rebind by hand if that is what is wanted:
--
--   SELECT source_id, details FROM communication_backfill_issues
--    WHERE domain = 'chat_channels' AND reason = 'duplicate_entity_channel_unbound';
--
-- No message, membership or channel was deleted in either direction.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_chat_channels_org_entity";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_chat_messages_org_reply";
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_chat_messages_channel_position";
--> statement-breakpoint

CREATE INDEX "idx_chat_messages_channel_position"
  ON "chat_messages" ("org_id", "channel_id", "channel_position" DESC)
  WHERE "is_deleted" = false;

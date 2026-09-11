-- 1058 — the three catalog objects the chat read paths were missing, and one
--        declaration-versus-catalog drift they were tripping over.
--
-- Measured on scratch_bechat_perf: 400,000 chat_messages across 80 channels in two
-- tenants, 3,000 chat_channel_members, 0.5% of messages soft-deleted, ANALYZEd, with the
-- catalog's exact chat index set as it stands at journal head. Every number below is
-- `EXPLAIN (ANALYZE, BUFFERS)` from that database.
--
-- ============================================================================
-- (1) idx_chat_messages_channel_position becomes TOTAL.
-- ============================================================================
--
-- The DECLARATION — src/db/schema/chat/chat-message-tables.ts:51 — says
--
--     index("idx_chat_messages_channel_position")
--       .on(table.orgId, table.channelId, table.channelPosition)
--
-- with no `.where()`. The catalog says
--
--     CREATE INDEX idx_chat_messages_channel_position
--       ON chat_messages (org_id, channel_id, channel_position DESC)
--       WHERE (is_deleted = false)
--
-- so this is the same declaration-versus-catalog drift class as 1054, one table over.
--
-- What the drift costs. `ChatMessageTimelineService.list` — GET /chat/channels/:id/messages,
-- the read behind opening ANY channel — is
--
--     WHERE org_id = ? AND channel_id = ? ORDER BY channel_position DESC LIMIT 51
--
-- with NO is_deleted predicate, because the product renders soft-deleted messages as
-- tombstones (frontend features/chat/chat-bubble.tsx:185; ChatMessageModerationService.remove
-- already nulls the content). Both indexes that could serve that ordering —
-- idx_chat_messages_channel_position and idx_chat_messages_unread — are partial on exactly
-- `is_deleted = false`, so Postgres may use neither and falls back to reading the whole
-- channel and top-N sorting it:
--
--     partial index, 5,000 messages in the channel
--       Bitmap Heap Scan (Heap Blocks: exact=5000) -> Sort (top-N) -> Limit
--       Execution Time 1772.6 ms   Buffers: shared read=5022 written=149
--
--     total index, same query, same data
--       Index Scan using idx_chat_messages_channel_position -> Limit
--       Execution Time 0.256 ms    Buffers: shared hit=51 read=3
--
-- ~6,900x on time and ~93x on buffers, and the bad plan reads the WHOLE channel, so the
-- gap grows linearly with history.
--
-- Why TOTAL rather than a second, non-partial index beside the partial one. A second index
-- would fix the same read, but it costs a second 16 MB structure and a second write on
-- every insert into the hottest table in the product, and it would leave the drift in
-- place. Widening the predicate costs neither, and the partial form buys nothing here: the
-- `is_deleted = false` readers keep the same plan through the total index, because
-- is_deleted is not in the key either way and both forms recheck it against the heap —
--
--     WHERE org_id=? AND channel_id=? AND is_deleted=false ORDER BY channel_position DESC LIMIT 51
--       partial index   Execution Time 0.388 ms   Buffers: shared hit=51 read=3
--       total index     Execution Time 0.102 ms   Buffers: shared hit=55  (Rows Removed by Filter: 1)
--
-- and at 0.5% deleted the size difference is under 1%. `poll()`, whose forward scan is
-- `channel_position > cursor ORDER BY channel_position ASC`, is served by the same index
-- read backward (Index Scan Backward, 57 buffers) with or without the predicate, which is
-- what lets that route stop filtering tombstones out and start agreeing with list().
--
-- The house rule that soft-delete indexes are partial (backend/CLAUDE.md §3) is about
-- columns whose deleted rows are never read. `chat_messages.is_deleted` is a TOMBSTONE
-- flag, not a soft delete: the row is deliberately still rendered. An index that cannot
-- serve the read the product actually performs is the wrong shape for this column.
--
-- idx_chat_messages_unread stays PARTIAL. Its readers — the unread counters and the
-- channel-list last-message probe — all carry `is_deleted = false`, so the predicate is
-- doing real work there.
--
-- ============================================================================
-- (2) idx_chat_messages_org_reply is created.
-- ============================================================================
--
-- `ChatMessageTimelineService.listThreadReplies` — GET .../messages/:messageId/thread,
-- the read behind opening any thread panel — filters on reply_to_id, and none of the
-- eight indexes on chat_messages covers it. Cost is O(tenant messages), not O(thread):
--
--     no index      Parallel Seq Scan, Rows Removed by Filter: 133,320 per worker x 3
--                   Execution Time 47.4 ms   Buffers: shared hit=74 read=6830
--     with index    Index Scan Backward using idx_chat_messages_org_reply
--                   Execution Time 0.079 ms  Buffers: shared hit=5 read=3
--
-- PARTIAL on `reply_to_id IS NOT NULL` because the only predicate that ever reads it is an
-- equality, which implies NOT NULL, and most messages are not replies: on the measured set
-- the partial index is 16 kB against 3,000 kB total, same plan, same 0.05 ms. This index is
-- never an ON CONFLICT arbiter, so being partial costs it nothing (contrast 1054).
--
-- ============================================================================
-- (3) uniq_chat_channels_org_entity is created.
-- ============================================================================
--
-- `ChatChannelsService.getOrCreateEntityChannel` is a check-then-insert with nothing behind
-- it: idx_chat_channels_org_entity is a PLAIN index, and there is no unique constraint, no
-- advisory lock and no ON CONFLICT. Its only caller is a TanStack `useQuery`
-- (frontend hooks/api/chat-personal-b.ts:57-65) — a GET that writes — so a StrictMode
-- double-mount, two tabs or a query retry issue two concurrent
-- `GET /chat/channels/entity/:type/:id`, both miss the findFirst and both insert. The
-- record then has two channels; findFirst returns whichever the scan reaches first, so
-- messages split unpredictably between them and members of one never see the other.
-- `createChannel` accepts entityType/entityId too and does not check at all, so an
-- application-side lock could not close this on its own — the invariant has to live in the
-- catalog.
--
-- PARTIAL on `entity_type IS NOT NULL`: the great majority of channels are not attached to
-- a record and must not be forced into a shared uniqueness class. The call site names the
-- predicate in its ON CONFLICT target (`targetWhere`), which is what makes it inferable —
-- the 1054 lesson applied prospectively rather than after the fact.
--
-- EXISTING DUPLICATES. A UNIQUE index cannot be built over them, and this migration must
-- neither guess which channel is canonical nor delete anyone's messages. It keeps the
-- OLDEST channel (lowest id) bound to the record and UNBINDS the newer ones by setting
-- their entity_type/entity_id to NULL: no channel is deleted, no message is lost, no
-- membership changes, and the extra channel survives as an ordinary GROUP channel its
-- members can still open. Every unbinding is recorded in communication_backfill_issues —
-- the same table 0713 used for exactly this purpose — so an operator can find and merge
-- them by hand. On a database with no duplicates this step writes nothing.
--
-- LOCKING. drizzle-kit migrate wraps the file in one transaction, so CONCURRENTLY is not
-- available (check-migration-discipline rule 6 allows a non-concurrent build with a
-- lock_timeout, which is set below). The DROP/CREATE in (1) takes ACCESS EXCLUSIVE on
-- chat_messages from the drop until COMMIT, so there is no window in which the index is
-- missing and a concurrent reader can see it; if anything below fails the whole file rolls
-- back with the old index intact.

SET lock_timeout = '5s';
--> statement-breakpoint

SET statement_timeout = 0;
--> statement-breakpoint

-- (1) --------------------------------------------------------------------------
DROP INDEX IF EXISTS "idx_chat_messages_channel_position";
--> statement-breakpoint

CREATE INDEX "idx_chat_messages_channel_position"
  ON "chat_messages" ("org_id", "channel_id", "channel_position" DESC);
--> statement-breakpoint

-- (2) --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "idx_chat_messages_org_reply"
  ON "chat_messages" ("org_id", "reply_to_id", "channel_position")
  WHERE "reply_to_id" IS NOT NULL;
--> statement-breakpoint

-- (3) --------------------------------------------------------------------------
-- Record before repairing, so the audit row exists even if a later statement fails and
-- the whole file rolls back together.
INSERT INTO communication_backfill_issues (org_id, domain, source_id, reason, details)
SELECT
  dup.org_id,
  'chat_channels',
  dup.id::text,
  'duplicate_entity_channel_unbound',
  jsonb_build_object(
    'entityType', dup.entity_type,
    'entityId', dup.entity_id,
    'canonicalChannelId', dup.canonical_id,
    'channelName', dup.name
  )
FROM (
  SELECT
    c.id,
    c.org_id,
    c.name,
    c.entity_type,
    c.entity_id,
    min(c.id) OVER (PARTITION BY c.org_id, c.entity_type, c.entity_id) AS canonical_id
  FROM chat_channels c
  WHERE c.entity_type IS NOT NULL
) dup
WHERE dup.id <> dup.canonical_id;
--> statement-breakpoint

UPDATE chat_channels tgt
SET entity_type = NULL,
    entity_id = NULL
FROM (
  SELECT
    c.id,
    min(c.id) OVER (PARTITION BY c.org_id, c.entity_type, c.entity_id) AS canonical_id
  FROM chat_channels c
  WHERE c.entity_type IS NOT NULL
) dup
WHERE tgt.id = dup.id
  AND dup.id <> dup.canonical_id;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_chat_channels_org_entity"
  ON "chat_channels" ("org_id", "entity_type", "entity_id")
  WHERE "entity_type" IS NOT NULL;
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success over a
-- statement that did nothing, and IF NOT EXISTS hides a no-op.
DO $$
DECLARE
  position_pred text;
  reply_pred text;
  entity_unique boolean;
  entity_pred text;
BEGIN
  SELECT pg_get_expr(x.indpred, x.indrelid) INTO position_pred
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_chat_messages_channel_position'
     AND x.indrelid = 'chat_messages'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1058: idx_chat_messages_channel_position is missing after this migration';
  END IF;
  IF position_pred IS NOT NULL THEN
    RAISE EXCEPTION '1058: idx_chat_messages_channel_position is still partial (indpred = %)', position_pred;
  END IF;

  SELECT pg_get_expr(x.indpred, x.indrelid) INTO reply_pred
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_chat_messages_org_reply'
     AND x.indrelid = 'chat_messages'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1058: idx_chat_messages_org_reply was not created';
  END IF;
  IF reply_pred IS NULL THEN
    RAISE EXCEPTION '1058: idx_chat_messages_org_reply lost its reply_to_id IS NOT NULL predicate';
  END IF;

  SELECT x.indisunique, pg_get_expr(x.indpred, x.indrelid) INTO entity_unique, entity_pred
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'uniq_chat_channels_org_entity'
     AND x.indrelid = 'chat_channels'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1058: uniq_chat_channels_org_entity was not created';
  END IF;
  IF NOT entity_unique THEN
    RAISE EXCEPTION '1058: uniq_chat_channels_org_entity is not UNIQUE';
  END IF;
  IF entity_pred IS NULL THEN
    RAISE EXCEPTION '1058: uniq_chat_channels_org_entity lost its entity_type IS NOT NULL predicate — every entity-less channel is now in one uniqueness class';
  END IF;
END
$$;

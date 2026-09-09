-- 1074 — the chat unread cursor stops being a wall clock.
--
-- THE DEFECT. There is no stored unread counter: unread is derived at read time, in two
-- places, as a COUNT of messages newer than a per-member cursor —
-- `chat-channel-list.service.ts` (the sidebar's per-channel counts) and
-- `chat-presence.service.ts` (the GET /chat/unread badge). Both compared
-- `chat_messages.created_at` against `chat_channel_members.last_read_at`, and neither is a
-- commit order. `created_at` is `DEFAULT now()`, and `now()` is TRANSACTION START, while
-- `TenantContextInterceptor` opens ONE transaction for the whole request. `ChatMessagesService.send`
-- then takes an exclusive row lock on the channel row to allocate `channel_position`, so
-- concurrent sends serialize there and a later-committing send carries an EARLIER timestamp:
--
--   t=10   sender B's request begins, created_at stamped 10; B blocks on the channel lock
--   t=100  reader R marks the channel read, last_read_at = 100
--   t=300  B commits; created_at is still 10
--
-- `10 > 100` is false, so B's message counts as already read — permanently, because nothing
-- revisits the comparison. `markChannelUnread` could not rescue it either: it set the cursor
-- to `latest.created_at - 1ms`, which for that same row also lands below 100. And because
-- `last_read_at` came from a NODE clock while `created_at` comes from the POSTGRES clock,
-- ordinary NTP skew loses messages with no concurrency involved at all.
--
-- THE FIX. 0774 already solved this time-base problem for PAGINATION by adding
-- `chat_messages.channel_position`, allocated under that same channel row lock via
-- `UPDATE chat_channels SET message_count = message_count + 1 … RETURNING`, hence monotone in
-- COMMIT order. The read cursor was never migrated with it. `last_read_position` is added
-- here and becomes the unread cursor.
--
-- `last_read_at` is KEPT: it is a published wire field, carried by
-- `chat-channel-member-shape.ts`, declared required in
-- `frontend/hooks/api/chat-schema/channel-schema.ts:31`, and read by the channel panel's
-- "new messages" divider (`frontend/features/chat/use-message-panel-data.ts:363`). Both
-- writers keep the two cursors in step so the divider and the badge cannot disagree.
--
-- THE BACKFILL. Each member's position is derived from the cursor they already hold — the
-- highest `channel_position` at or before their `last_read_at`, 0 where there is none — so
-- no badge jumps on deploy. Deliberately NOT filtered on `is_deleted`: a max over undeleted
-- rows only would return a LOWER position once the member's last read message is tombstoned,
-- and every undeleted message between the two would then count as unread.
--
-- THE INDEX. `idx_chat_messages_unread` is `(org_id, channel_id, is_deleted, created_at)`;
-- its trailing key was the OLD predicate's range column and it cannot range-scan
-- `channel_position`, a column it does not carry. It is NOT amended in place — its remaining
-- reader is the channel-list last-message LATERAL (`ORDER BY created_at DESC LIMIT 1`), and
-- re-pointing that key is the 1058 regression one table over. `idx_chat_messages_unread_position`
-- is added instead: same four columns with `channel_position` for `created_at`, same partial
-- predicate. `org_id` LEADS because `chat_messages` carries RLS (0378_rls_remaining_tenant_tables.sql),
-- the policy's `org_id = app.current_org_id()` qual is not leakproof, and an index-only scan is
-- impossible unless the index supplies `org_id` itself; `is_deleted` is carried so the readers'
-- own predicate needs no heap recheck. NOT MEASURED — the buffer counts this reasoning rests on
-- are 1058's, no database was opened for this file, and the shape follows backend/CLAUDE.md §7
-- rather than a plan.
--
-- LOCKING. `lock_timeout` so this fails fast instead of queueing in front of the chat tables;
-- `statement_timeout` cleared because the backfill and the index build both scale with
-- `chat_messages`. NOT NULL is installed additively (add nullable → backfill → CHECK NOT VALID
-- → VALIDATE → SET NOT NULL) so the last step skips the table scan. The DEFAULT lands AFTER
-- the backfill on purpose: with a default in place from the start the backfill's
-- `WHERE last_read_position IS NULL` matches nothing and every row silently keeps 0, which
-- reads as "every message you ever received is unread".

SET lock_timeout = '5s';
--> statement-breakpoint

SET statement_timeout = 0;
--> statement-breakpoint

ALTER TABLE "chat_channel_members" ADD COLUMN IF NOT EXISTS "last_read_position" bigint;
--> statement-breakpoint

UPDATE chat_channel_members cm
SET "last_read_position" = COALESCE((
  SELECT max(m."channel_position")
  FROM chat_messages m
  WHERE m."org_id" = cm."org_id"
    AND m."channel_id" = cm."channel_id"
    AND m."created_at" <= cm."last_read_at"
), 0)
WHERE cm."last_read_position" IS NULL;
--> statement-breakpoint

ALTER TABLE "chat_channel_members"
  ADD CONSTRAINT "chk_chat_channel_members_last_read_position_not_null"
  CHECK ("last_read_position" IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE "chat_channel_members"
  VALIDATE CONSTRAINT "chk_chat_channel_members_last_read_position_not_null";
--> statement-breakpoint

ALTER TABLE "chat_channel_members" ALTER COLUMN "last_read_position" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "chat_channel_members" ALTER COLUMN "last_read_position" SET DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "chat_channel_members"
  DROP CONSTRAINT "chk_chat_channel_members_last_read_position_not_null";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_chat_messages_unread_position"
  ON "chat_messages" ("org_id", "channel_id", "is_deleted", "channel_position")
  WHERE "is_deleted" = false;
--> statement-breakpoint

-- Read the catalog back rather than trusting completion: db:migrate reports success over a
-- statement that did nothing, and both IF NOT EXISTS clauses above hide a no-op.
DO $$
DECLARE
  nulls bigint;
  overshoot bigint;
  col_notnull boolean;
  col_default text;
  idx_pred text;
  idx_def text;
BEGIN
  SELECT count(*) INTO nulls FROM chat_channel_members WHERE last_read_position IS NULL;
  IF nulls > 0 THEN
    RAISE EXCEPTION '1074: % chat_channel_members rows still have a null last_read_position', nulls;
  END IF;

  SELECT count(*) INTO overshoot
  FROM chat_channel_members cm
  JOIN chat_channels c ON c.id = cm.channel_id AND c.org_id = cm.org_id
  WHERE cm.last_read_position > c.message_count;
  IF overshoot > 0 THEN
    RAISE EXCEPTION '1074: % members have last_read_position above their channel message_count — future messages would arrive pre-read', overshoot;
  END IF;

  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO col_notnull, col_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'chat_channel_members'::regclass
     AND a.attname = 'last_read_position'
     AND NOT a.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1074: chat_channel_members.last_read_position does not exist after this migration';
  END IF;
  IF NOT col_notnull THEN
    RAISE EXCEPTION '1074: chat_channel_members.last_read_position is still nullable';
  END IF;
  IF col_default IS NULL THEN
    RAISE EXCEPTION '1074: chat_channel_members.last_read_position has no DEFAULT — every insert site that omits it would fail NOT NULL';
  END IF;

  SELECT pg_get_expr(x.indpred, x.indrelid), pg_get_indexdef(x.indexrelid)
    INTO idx_pred, idx_def
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_chat_messages_unread_position'
     AND x.indrelid = 'chat_messages'::regclass;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1074: idx_chat_messages_unread_position was not created';
  END IF;
  IF idx_pred IS NULL THEN
    RAISE EXCEPTION '1074: idx_chat_messages_unread_position lost its is_deleted = false predicate';
  END IF;
  IF position('channel_position' in idx_def) = 0 THEN
    RAISE EXCEPTION '1074: idx_chat_messages_unread_position does not carry channel_position (%)', idx_def;
  END IF;
  IF position('(org_id' in idx_def) = 0 THEN
    RAISE EXCEPTION '1074: idx_chat_messages_unread_position does not lead with org_id — an index-only scan is impossible under RLS (%)', idx_def;
  END IF;

  PERFORM 1 FROM pg_class WHERE relname = 'idx_chat_messages_unread';
  IF NOT FOUND THEN
    RAISE EXCEPTION '1074: idx_chat_messages_unread is gone — the channel-list last-message probe lost its ordering';
  END IF;
END
$$;

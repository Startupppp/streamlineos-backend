-- C21-03: notifications watermark, cursor index, chat unread index
-- mark-all-read becomes an O(1) upsert; list and count indexes align with the
-- ORDER BY id DESC / cursor id < ? query shape; chat unread index gains org_id
-- so the planner can use it under RLS.

SET lock_timeout = '5s';

-- 1. Watermark: one row per (org_id, user_id), advanced by mark-all-read.
--    Existing is_read booleans are not touched; the watermark supplements them.
--    A missing row means lastReadId = 0 (no watermark applied yet).
CREATE TABLE notification_read_watermarks (
  id                        bigint      NOT NULL GENERATED ALWAYS AS IDENTITY,
  org_id                    text        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                   text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_notification_id bigint      NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_notification_read_watermarks PRIMARY KEY (id),
  CONSTRAINT uniq_notification_read_watermarks_org_user UNIQUE (org_id, user_id),
  CONSTRAINT uniq_notification_read_watermarks_org_id UNIQUE (org_id, id)
);

CREATE INDEX idx_notif_read_watermarks_lookup
  ON notification_read_watermarks (org_id, user_id);

-- 2. Replace the old notifications unread index.
--    Old: (org_id, user_id, is_read, created_at DESC) — served ORDER BY created_at
--    but the list queries ORDER BY id, so the old sort column mismatched.
DROP INDEX IF EXISTS idx_notifications_org_user_unread;

-- For list queries: ORDER BY id DESC + cursor WHERE id < ?.
-- org_id leads so the RLS policy qual is covered by the index; partial condition
-- keeps deleted/archived rows out of the structure entirely.
CREATE INDEX idx_notifications_list_cursor
  ON notifications (org_id, user_id, id DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- For unread count: seek to (org_id, user_id, watermark) and count forward.
-- Partial condition restricts the index to unread, live rows only, so after
-- mark-all-read a count scans only newly-arrived rows.
CREATE INDEX idx_notifications_unread_count
  ON notifications (org_id, user_id, id)
  WHERE deleted_at IS NULL AND archived_at IS NULL AND is_read = false;

-- 3. Fix the chat unread index.
--    Old: (channel_id, is_deleted, created_at) — org_id absent.
--    Under RLS the planner requires org_id in the index; without it the index is
--    silently skipped and every channel unread query becomes a seq scan.
DROP INDEX IF EXISTS idx_chat_messages_unread;

CREATE INDEX idx_chat_messages_unread
  ON chat_messages (org_id, channel_id, is_deleted, created_at)
  WHERE is_deleted = false;

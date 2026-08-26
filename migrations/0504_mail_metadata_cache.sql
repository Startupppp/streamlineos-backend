-- c21-06: mail_message_metadata — persistent per-user mail metadata cache.
-- Subject, sender, date, thread_id, read state, labels are stored per message.
-- Body and attachments are never persisted: they are fetched on demand from the
-- provider. org_id is included so the RLS policy qual is covered by every index;
-- per-user isolation is enforced through user_id on every query.
-- CONCURRENTLY cannot run inside a transaction — note it for the operator.

SET lock_timeout = '5s';

CREATE TABLE mail_message_metadata (
  id             bigint      PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  account_id     integer     NOT NULL,
  user_id        text        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  org_id         text        NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
  message_id     text        NOT NULL,
  thread_id      text,
  subject        text        NOT NULL DEFAULT '',
  sender_email   text        NOT NULL DEFAULT '',
  sender_name    text,
  date           timestamptz,
  is_read        boolean     NOT NULL DEFAULT false,
  is_starred     boolean     NOT NULL DEFAULT false,
  labels         jsonb,
  folder         text        NOT NULL DEFAULT 'inbox',
  has_attachment boolean     NOT NULL DEFAULT false,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_mail_metadata_account_msg UNIQUE (account_id, message_id),
  CONSTRAINT uniq_mail_metadata_org_id      UNIQUE (org_id, id)
);

ALTER TABLE mail_message_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON mail_message_metadata
  USING  (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id());

-- Inbox list: (org_id, user_id, folder, date DESC) — covers ORDER BY date DESC.
-- CONCURRENTLY form for the operator: CREATE INDEX CONCURRENTLY idx_mail_metadata_list ...
CREATE INDEX IF NOT EXISTS idx_mail_metadata_list
  ON mail_message_metadata (org_id, user_id, folder, date DESC)
  WHERE date IS NOT NULL;

-- Thread grouping: (org_id, user_id, thread_id) — covers thread-view queries.
CREATE INDEX IF NOT EXISTS idx_mail_metadata_thread
  ON mail_message_metadata (org_id, user_id, thread_id)
  WHERE thread_id IS NOT NULL;

-- Freshness check per account: latest synced_at is a single seek.
CREATE INDEX IF NOT EXISTS idx_mail_metadata_account_sync
  ON mail_message_metadata (account_id, synced_at DESC);

-- Search fallback: enables ILIKE over subject/sender without scanning the full table.
CREATE INDEX IF NOT EXISTS idx_mail_metadata_search
  ON mail_message_metadata (org_id, user_id, synced_at DESC);

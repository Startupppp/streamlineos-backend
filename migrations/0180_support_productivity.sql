ALTER TYPE "support_ticket_link_relation" ADD VALUE IF NOT EXISTS 'split';
ALTER TYPE "support_activity_action" ADD VALUE IF NOT EXISTS 'split';
ALTER TYPE "support_activity_action" ADD VALUE IF NOT EXISTS 'snoozed';
ALTER TYPE "support_activity_action" ADD VALUE IF NOT EXISTS 'unsnoozed';

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS snoozed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_support_tickets_snoozed_until ON support_tickets (snoozed_until);

CREATE TABLE IF NOT EXISTS support_message_mentions (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES support_ticket_messages(id) ON DELETE CASCADE,
  mentioned_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_message_mentions_message_user ON support_message_mentions (message_id, mentioned_user_id);
CREATE INDEX IF NOT EXISTS idx_support_message_mentions_message ON support_message_mentions (message_id);

CREATE TABLE IF NOT EXISTS support_ticket_drafts (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  is_internal BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_ticket_drafts_ticket_user ON support_ticket_drafts (ticket_id, user_id);

DO $$ BEGIN
  CREATE TYPE "support_external_entity_type" AS ENUM ('project', 'invoice', 'calendar_event', 'chat_channel');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS support_ticket_external_links (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  entity_type "support_external_entity_type" NOT NULL,
  entity_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_ticket_external_links_ticket_entity
  ON support_ticket_external_links (ticket_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_support_ticket_external_links_org_ticket
  ON support_ticket_external_links (org_id, ticket_id);

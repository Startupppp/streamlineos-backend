-- migration 0215: hr helpdesk comments + routing + calendar prep

ALTER TABLE helpdesk_tickets
  ADD COLUMN IF NOT EXISTS is_confidential boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_due_at timestamp;

CREATE TABLE IF NOT EXISTS hr_helpdesk_routing (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category text NOT NULL,
  assignee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT uniq_helpdesk_routing_org_category UNIQUE (org_id, category)
);

CREATE INDEX IF NOT EXISTS idx_hr_helpdesk_routing_org ON hr_helpdesk_routing (org_id);

CREATE TABLE IF NOT EXISTS hr_helpdesk_comments (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES helpdesk_tickets(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_helpdesk_comments_ticket ON hr_helpdesk_comments (ticket_id);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_org_status ON helpdesk_tickets (org_id, status);
CREATE INDEX IF NOT EXISTS idx_helpdesk_tickets_org_user ON helpdesk_tickets (org_id, user_id);

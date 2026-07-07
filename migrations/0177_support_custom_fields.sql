-- Ticket forms / custom fields: admin-defined fields captured at ticket creation.
CREATE TABLE IF NOT EXISTS support_custom_fields (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options JSONB,
  required BOOLEAN NOT NULL DEFAULT false,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_custom_fields_org_key ON support_custom_fields (org_id, key);
CREATE INDEX IF NOT EXISTS idx_support_custom_fields_org_active ON support_custom_fields (org_id, is_active);

CREATE TABLE IF NOT EXISTS support_ticket_custom_field_values (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES support_custom_fields(id) ON DELETE CASCADE,
  value TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_ticket_custom_field_values_ticket_field
  ON support_ticket_custom_field_values (ticket_id, field_id);
CREATE INDEX IF NOT EXISTS idx_support_ticket_custom_field_values_org_ticket
  ON support_ticket_custom_field_values (org_id, ticket_id);

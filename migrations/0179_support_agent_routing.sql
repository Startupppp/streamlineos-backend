-- Skill-based / availability-based / VIP routing support.
ALTER TABLE support_routing_rules
  ADD COLUMN IF NOT EXISTS required_skills JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS support_agent_skills (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_agent_skills_user_skill ON support_agent_skills (user_id, skill);
CREATE INDEX IF NOT EXISTS idx_support_agent_skills_org ON support_agent_skills (org_id, skill);

CREATE TABLE IF NOT EXISTS support_agent_availability (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_available BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_agent_availability_user ON support_agent_availability (user_id);

CREATE TABLE IF NOT EXISTS support_vip_clients (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_vip_clients_org_client ON support_vip_clients (org_id, client_id);

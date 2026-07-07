-- Audit trail for SLA/business-hours/automation/channel/custom-field config changes.
CREATE TABLE IF NOT EXISTS support_settings_audit_log (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_settings_audit_log_org_created ON support_settings_audit_log (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_settings_audit_log_org_entity ON support_settings_audit_log (org_id, entity_type);

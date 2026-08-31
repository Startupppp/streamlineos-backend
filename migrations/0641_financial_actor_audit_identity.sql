ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_membership_id integer;

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_actor_membership
  ON audit_logs (org_id, actor_membership_id);

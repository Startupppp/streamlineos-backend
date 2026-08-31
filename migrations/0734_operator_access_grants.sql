-- Operator access grants: time-bounded, scoped, immutably logged access
-- by platform operators (support engineers) to customer org data.

CREATE TABLE operator_access_grants (
  grant_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  operator_user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  incident_ref TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Active-grant lookup: only unrevoked rows, index used on every guard check.
CREATE INDEX idx_oag_active
  ON operator_access_grants (operator_user_id, org_id, scope, expires_at)
  WHERE revoked_at IS NULL;

-- Immutable operator access log — no UPDATE/DELETE issued by the application.
-- Enforce at the app layer; for stronger guarantees add a PG rule post-migration:
--   CREATE RULE no_upd_op_log AS ON UPDATE TO operator_access_log DO INSTEAD NOTHING;
--   CREATE RULE no_del_op_log AS ON DELETE TO operator_access_log DO INSTEAD NOTHING;

CREATE TABLE operator_access_log (
  log_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES operator_access_grants(grant_id),
  operator_user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB,
  ip_address TEXT,
  accessed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_oal_grant ON operator_access_log (grant_id);
CREATE INDEX idx_oal_org_time ON operator_access_log (org_id, accessed_at DESC);

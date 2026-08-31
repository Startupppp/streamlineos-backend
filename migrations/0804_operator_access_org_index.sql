CREATE INDEX IF NOT EXISTS idx_oag_org_operator
  ON operator_access_grants (org_id, operator_user_id, scope, expires_at);

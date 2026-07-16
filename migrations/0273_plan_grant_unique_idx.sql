CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_credit_txns_plan_grant_ref ON ai_credit_transactions (org_id, reference_id) WHERE type = 'PLAN_GRANT' AND reference_id IS NOT NULL;

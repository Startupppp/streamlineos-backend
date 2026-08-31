SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_oag_org_operator
  ON operator_access_grants (org_id, operator_user_id, scope, expires_at);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'operator_access_grants' AND indexname = 'idx_oag_org_operator'
  ) THEN
    RAISE EXCEPTION '0804: idx_oag_org_operator is missing — the RLS org_id qual cannot be answered from an index';
  END IF;
END $$;

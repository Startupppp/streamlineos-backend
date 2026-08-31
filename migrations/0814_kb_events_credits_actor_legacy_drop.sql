-- 0814_kb_events_credits_actor_legacy_drop
-- Drop the legacy users.id FK columns actor_id from kb_events and
-- tenant_ai_credit_transactions after companions were added and validated in 0813.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kb_events
  DROP CONSTRAINT IF EXISTS kb_events_actor_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE kb_events
  DROP COLUMN IF EXISTS actor_id;
--> statement-breakpoint
ALTER TABLE tenant_ai_credit_transactions
  DROP CONSTRAINT IF EXISTS tenant_ai_credit_transactions_actor_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE tenant_ai_credit_transactions
  DROP COLUMN IF EXISTS actor_id;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'kb_events' AND column_name = 'actor_id'
  ) THEN
    RAISE EXCEPTION '0814: actor_id column still exists on kb_events after drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenant_ai_credit_transactions' AND column_name = 'actor_id'
  ) THEN
    RAISE EXCEPTION '0814: actor_id column still exists on tenant_ai_credit_transactions after drop';
  END IF;
END
$$;

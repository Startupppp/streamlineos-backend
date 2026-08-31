-- 0813_kb_events_credits_actor_membership_companion
-- Add actor_membership_id companions for kb_events and tenant_ai_credit_transactions,
-- backfill from organization_members, add FK NOT VALID, then validate.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kb_events ADD COLUMN IF NOT EXISTS actor_membership_id integer;
--> statement-breakpoint
ALTER TABLE tenant_ai_credit_transactions ADD COLUMN IF NOT EXISTS actor_membership_id integer;
--> statement-breakpoint
UPDATE kb_events t
SET actor_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.actor_id
  AND t.actor_id IS NOT NULL
  AND t.actor_membership_id IS NULL;
--> statement-breakpoint
UPDATE tenant_ai_credit_transactions t
SET actor_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.actor_id
  AND t.actor_id IS NOT NULL
  AND t.actor_membership_id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_kb_events_org_actor_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE kb_events
      ADD CONSTRAINT fk_kb_events_org_actor_membership
      FOREIGN KEY (org_id, actor_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (actor_membership_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_tenant_ai_credit_txns_org_actor_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE tenant_ai_credit_transactions
      ADD CONSTRAINT fk_tenant_ai_credit_txns_org_actor_membership
      FOREIGN KEY (org_id, actor_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (actor_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE kb_events VALIDATE CONSTRAINT fk_kb_events_org_actor_membership;
--> statement-breakpoint
ALTER TABLE tenant_ai_credit_transactions VALIDATE CONSTRAINT fk_tenant_ai_credit_txns_org_actor_membership;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_events_org_actor_membership
  ON kb_events (org_id, actor_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tenant_ai_credit_txns_org_actor
  ON tenant_ai_credit_transactions (org_id, actor_membership_id);
